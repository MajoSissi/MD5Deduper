package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const hashBufSize = 1 << 20 // 1 MiB

// ---------------------------------------------------------------- 文件枚举

type fileRef struct {
	Path  string
	Size  int64
	MTime int64
}

type walker struct {
	recursive  bool
	skipHidden bool
	minSize    int64
	exclude    []string
	onTick     func(n int)
	files      []fileRef
	errs       []string
	mu         sync.Mutex
}

func newWalker(recursive, skipHidden bool, minSize int64, exclude []string) *walker {
	return &walker{recursive: recursive, skipHidden: skipHidden, minSize: minSize, exclude: exclude}
}

func (w *walker) errf(format string, a ...interface{}) {
	w.mu.Lock()
	if len(w.errs) < 500 {
		w.errs = append(w.errs, fmt.Sprintf(format, a...))
	}
	w.mu.Unlock()
}

func (w *walker) run(roots []string) {
	for _, r := range roots {
		if r == "" {
			continue
		}
		st, err := os.Stat(r)
		if err != nil {
			w.errf("%s: %v", r, err)
			continue
		}
		if !st.IsDir() {
			if st.Size() >= w.minSize && !w.excluded(filepath.Base(r), r) {
				w.files = append(w.files, fileRef{r, st.Size(), st.ModTime().Unix()})
			}
			continue
		}
		w.walk(r)
	}
}

func (w *walker) walk(root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			w.errf("%s: %v", path, err)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == root {
			return nil
		}
		name := d.Name()

		if d.IsDir() {
			if !w.recursive {
				return fs.SkipDir
			}
			if w.excluded(name, path) {
				return fs.SkipDir
			}
			if w.skipHidden && isHiddenEntry(d) {
				return fs.SkipDir
			}
			return nil
		}

		if !d.Type().IsRegular() {
			return nil
		}
		if w.excluded(name, path) {
			return nil
		}
		if w.skipHidden && isHiddenEntry(d) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			w.errf("%s: %v", path, ierr)
			return nil
		}
		if info.Size() < w.minSize {
			return nil
		}
		w.files = append(w.files, fileRef{path, info.Size(), info.ModTime().Unix()})
		if w.onTick != nil {
			w.onTick(len(w.files))
		}
		return nil
	})
}

// excluded 判断是否命中排除规则
func (w *walker) excluded(name, path string) bool {
	for _, p := range w.exclude {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, "*?[") {
			if ok, _ := filepath.Match(p, name); ok {
				return true
			}
			if ok, _ := filepath.Match(p, path); ok {
				return true
			}
			continue
		}
		if strings.EqualFold(p, name) || strings.Contains(strings.ToLower(path), strings.ToLower(p)) {
			return true
		}
	}
	return false
}

// isHiddenEntry 判断是否隐藏（"." 开头 或 Windows 隐藏/系统属性）
func isHiddenEntry(d fs.DirEntry) bool {
	if strings.HasPrefix(d.Name(), ".") {
		return true
	}
	info, err := d.Info()
	if err != nil {
		return false
	}
	return isHiddenInfo(info)
}

// ---------------------------------------------------------------- 哈希引擎

type hashTask struct {
	idx int
	ref fileRef
}

func effectiveConcurrency(n int) int {
	if n > 0 {
		if n > 64 {
			return 64
		}
		return n
	}
	c := runtime.NumCPU()
	if c > 8 {
		c = 8
	}
	if c < 1 {
		c = 1
	}
	return c
}

// hashAll 并发计算 MD5。
// reuse 为 path(lower) -> 旧条目，命中且 size+mtime 未变时直接复用旧 MD5（增量扫描）。
func hashAll(ctx context.Context, files []fileRef, concurrency int, reuse map[string]Entry,
	onProgress func(done int, bytes int64)) (hashes []string, errs []string, reused int, errCount int) {

	n := len(files)
	hashes = make([]string, n)
	errSlice := make([]string, n)
	var done, skip, ecount, nbytes atomic.Int64

	tasks := make(chan hashTask, 128)
	var wg sync.WaitGroup
	bufPool := sync.Pool{New: func() interface{} { b := make([]byte, hashBufSize); return &b }}

	workers := effectiveConcurrency(concurrency)
	if workers > n {
		workers = n
	}
	if workers < 1 {
		workers = 1
	}

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range tasks {
				if ctx.Err() != nil {
					return
				}
				if reuse != nil {
					if old, ok := reuse[strings.ToLower(t.ref.Path)]; ok && old.Size == t.ref.Size &&
						len(old.Paths) > 0 && old.Paths[0].MTime == t.ref.MTime {
						hashes[t.idx] = old.MD5
						skip.Add(1)
						done.Add(1)
						continue
					}
				}
				bp := bufPool.Get().(*[]byte)
				sum, nread, err := hashFile(t.ref.Path, *bp)
				bufPool.Put(bp)
				if err != nil {
					errSlice[t.idx] = fmt.Sprintf("%s: %v", t.ref.Path, err)
					ecount.Add(1)
					done.Add(1)
					continue
				}
				hashes[t.idx] = sum
				nbytes.Add(nread)
				done.Add(1)
			}
		}()
	}

	progressDone := make(chan struct{})
	if onProgress != nil {
		go func() {
			ticker := time.NewTicker(150 * time.Millisecond)
			defer ticker.Stop()
			last := -1
			for {
				select {
				case <-progressDone:
					onProgress(int(done.Load()), nbytes.Load())
					return
				case <-ticker.C:
					d := int(done.Load())
					if d != last {
						last = d
						onProgress(d, nbytes.Load())
					}
				}
			}
		}()
	}

	for i := range files {
		if ctx.Err() != nil {
			break
		}
		tasks <- hashTask{idx: i, ref: files[i]}
	}
	close(tasks)
	wg.Wait()
	close(progressDone)

	for _, e := range errSlice {
		if e != "" {
			errs = append(errs, e)
			if len(errs) >= 300 {
				break
			}
		}
	}
	return hashes, errs, int(skip.Load()), int(ecount.Load())
}

func hashFile(path string, buf []byte) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := md5.New()
	n, err := io.CopyBuffer(h, f, buf)
	if err != nil {
		return "", n, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// ---------------------------------------------------------------- 扫描流程

type fileRow struct {
	Path  string `json:"path"`
	MD5   string `json:"md5"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
	Count int    `json:"count"`
	Dup   bool   `json:"dup"`
	Error string `json:"error,omitempty"`
}

type scanSession struct {
	Root    string
	Roots   []string
	Rows    []fileRow
	Groups  []DupGroup
	Result  ScanResult
	Started time.Time
}

// scanRoots 归一化扫描根目录：优先用 Roots，否则退回单个 Root（去重、去空白）
func scanRoots(req ScanRequest) []string {
	out := make([]string, 0, len(req.Roots)+1)
	seen := make(map[string]bool, len(req.Roots)+1)
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		k := strings.ToLower(p)
		if seen[k] {
			return
		}
		seen[k] = true
		out = append(out, p)
	}
	for _, r := range req.Roots {
		add(r)
	}
	add(req.Root)
	return out
}

// runScan 执行一次完整扫描（可传多个根目录，结果合并为一份）
func runScan(ctx context.Context, req ScanRequest, cfg Config, emit func(JobProgress),
	base *MD5List) (*ScanResult, *scanSession, error) {

	started := time.Now()
	roots := scanRoots(req)
	primary := ""
	if len(roots) > 0 {
		primary = roots[0]
	}
	res := &ScanResult{Root: primary, Roots: roots}
	sess := &scanSession{Root: primary, Roots: roots, Started: started}

	emitP := func(p JobProgress) {
		p.Kind = "scan"
		p.ElapsedMs = time.Since(started).Milliseconds()
		emit(p)
	}

	// 阶段一：枚举（多根目录依次遍历，结果合并）
	w := newWalker(true, req.Options.SkipHidden, req.Options.MinSize, req.Options.Exclude)
	w.onTick = func(n int) {
		if n%500 == 0 {
			emitP(JobProgress{Phase: "walking", Total: n, Done: n})
		}
	}
	w.run(roots)

	if ctx.Err() != nil {
		res.OK, res.Error = false, "已取消"
		return res, sess, nil
	}

	files := w.files
	total := len(files)
	sizeByPath := make(map[string]int64, total)
	for _, f := range files {
		sizeByPath[f.Path] = f.Size
	}

	// 增量复用
	var reuse map[string]Entry
	if req.Incremental && base != nil {
		reuse = make(map[string]Entry, len(base.Entries))
		for _, e := range base.Entries {
			for _, p := range e.Paths {
				reuse[strings.ToLower(p.Path)] = e
			}
		}
	}

	emitP(JobProgress{Phase: "hashing", Total: total})

	hashes, errList, reused, _ := hashAll(ctx, files, cfg.Concurrency, reuse,
		func(done int, bytes int64) {
			emitP(JobProgress{Phase: "hashing", Total: total, Done: done, Bytes: bytes})
		})

	if ctx.Err() != nil {
		res.OK, res.Error = false, "已取消"
		return res, sess, nil
	}

	// 组装行
	rows := make([]fileRow, 0, total)
	byMD5 := make(map[string][]PathRef, total)
	var totalSize int64
	errMap := make(map[string]string, len(errList))
	for _, e := range errList {
		if i := strings.LastIndex(e, ": "); i > 0 {
			errMap[e[:i]] = e[i+2:]
		}
	}
	for i, f := range files {
		row := fileRow{Path: f.Path, Size: f.Size, MTime: f.MTime, MD5: hashes[i]}
		if msg, ok := errMap[f.Path]; ok {
			row.Error = msg
		}
		if hashes[i] != "" {
			byMD5[hashes[i]] = append(byMD5[hashes[i]], PathRef{Path: f.Path, MTime: f.MTime})
		}
		totalSize += f.Size
		rows = append(rows, row)
	}
	sort.Slice(rows, func(a, b int) bool { return strings.ToLower(rows[a].Path) < strings.ToLower(rows[b].Path) })

	// 重复组
	groups := make([]DupGroup, 0, 64)
	for md5v, paths := range byMD5 {
		if len(paths) < 2 {
			continue
		}
		sort.Slice(paths, func(a, b int) bool { return paths[a].Path < paths[b].Path })
		sz := sizeByPath[paths[0].Path]
		groups = append(groups, DupGroup{
			MD5: md5v, Size: sz, Count: len(paths), Paths: paths,
			Waste: sz * int64(len(paths)-1),
		})
	}
	sort.Slice(groups, func(a, b int) bool {
		if groups[a].Waste == groups[b].Waste {
			return groups[a].MD5 < groups[b].MD5
		}
		return groups[a].Waste > groups[b].Waste
	})

	var dupFiles int
	var waste int64
	for i := range rows {
		if rows[i].MD5 == "" {
			continue
		}
		c := len(byMD5[rows[i].MD5])
		rows[i].Count = c
		rows[i].Dup = c > 1
		if c > 1 {
			dupFiles++
		}
	}
	for _, g := range groups {
		waste += g.Waste
	}

	sess.Rows = rows
	sess.Groups = groups

	res.OK = true
	res.Files = total
	res.Unique = len(byMD5)
	res.Groups = len(groups)
	res.DupFiles = dupFiles
	res.Waste = waste
	res.TotalSize = totalSize
	res.Errors = len(errList)
	res.Skipped = reused
	res.ElapsedMs = time.Since(started).Milliseconds()
	if len(groups) > 300 {
		res.GroupsTop = groups[:300]
	} else {
		res.GroupsTop = groups
	}

	emitP(JobProgress{Phase: "done", Total: total, Done: total})
	return res, sess, nil
}
