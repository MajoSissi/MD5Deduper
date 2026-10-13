package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// appVersion 程序版本号。
// 刻意声明为 var 而非 const，这样 CI 可以用 -ldflags "-X main.appVersion=x.y.z" 注入。
var appVersion = "1.0.0"

// listCacheEntry 列表读缓存
type listCacheEntry struct {
	list *MD5List
	mod  time.Time
}

// App 绑定给前端的应用对象
type App struct {
	ctx   context.Context
	store *Store
	cfg   Config

	mu        sync.Mutex
	jobs      map[string]context.CancelFunc
	scans     map[string]*scanSession
	checks    map[string]*checkSession
	order     []string
	lastKey   map[string]string // kind -> 最近一次的 jobID
	forceQuit bool              // 用户已确认退出，跳过关闭拦截

	cmu    sync.Mutex
	lcache map[string]listCacheEntry
}

// NewApp 创建应用
func NewApp() *App {
	return &App{
		jobs:    map[string]context.CancelFunc{},
		scans:   map[string]*scanSession{},
		checks:  map[string]*checkSession{},
		lastKey: map[string]string{},
		lcache:  map[string]listCacheEntry{},
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	st, err := NewStore()
	if err != nil {
		wailsruntime.LogError(ctx, "初始化数据目录失败: "+err.Error())
		return
	}
	a.store = st
	a.cfg = st.LoadConfig()
	wailsruntime.EventsEmit(ctx, "app:ready", a.env())
}

func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	for _, c := range a.jobs {
		c()
	}
	a.mu.Unlock()
}

// hasRunningJob 是否有正在进行的任务
func (a *App) hasRunningJob() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.jobs) > 0
}

// allowClose 是否已由用户确认退出（确认后不再拦截关闭）
func (a *App) allowClose() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.forceQuit
}

// ForceQuit 前端已确认退出，跳过关闭拦截直接退出程序
func (a *App) ForceQuit() {
	a.mu.Lock()
	a.forceQuit = true
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		wailsruntime.Quit(ctx)
	}
}

func (a *App) env() EnvInfo {
	e := EnvInfo{Version: appVersion, OS: runtime.GOOS, NumCPU: runtime.NumCPU()}
	if a.store != nil {
		e.DataDir = a.store.DataDir()
		e.ExeDir = a.store.ExeDir()
	}
	return e
}

// ---------------------------------------------------------------- 环境 / 配置

// GetEnv 返回运行环境信息
func (a *App) GetEnv() EnvInfo { return a.env() }

// GetConfig 返回当前配置
func (a *App) GetConfig() Config {
	if a.store == nil {
		return defaultConfig()
	}
	a.cfg = a.store.LoadConfig()
	return a.cfg
}

// SetConfig 保存配置
func (a *App) SetConfig(cfg Config) error {
	if a.store == nil {
		return fmt.Errorf("数据目录未就绪")
	}
	a.cfg = cfg
	return a.store.SaveConfig(cfg)
}

// OpenDataDir 打开数据目录
func (a *App) OpenDataDir() error {
	if a.store == nil {
		return fmt.Errorf("数据目录未就绪")
	}
	return revealInExplorer(a.store.DataDir())
}

// RevealPath 在资源管理器中定位
func (a *App) RevealPath(path string) error { return revealInExplorer(path) }

// ---------------------------------------------------------------- 选择器

// PickDirectory 选择目录
func (a *App) PickDirectory(title, defaultDir string) (string, error) {
	if title == "" {
		title = "选择目录"
	}
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:            title,
		DefaultDirectory: defaultDir,
	})
}

// PickFiles 选择多个文件
func (a *App) PickFiles(title string) ([]string, error) {
	if title == "" {
		title = "选择文件"
	}
	r, err := wailsruntime.OpenMultipleFilesDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: title})
	if err != nil || r == nil {
		return []string{}, err
	}
	return r, nil
}

// PickSavePath 选择保存位置
func (a *App) PickSavePath(defaultName, filterDesc, pattern string) (string, error) {
	return wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "导出到",
		DefaultFilename: defaultName,
		Filters:         []wailsruntime.FileFilter{{DisplayName: filterDesc, Pattern: pattern}},
	})
}

// PickOpenPath 选择要导入的文件
func (a *App) PickOpenPath(title string) (string, error) {
	return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:   title,
		Filters: []wailsruntime.FileFilter{{DisplayName: "MD5 列表 (*.json)", Pattern: "*.json"}},
	})
}

// ---------------------------------------------------------------- 拖放辅助

// PathKind 拖入路径的类型信息
type PathKind struct {
	Path  string `json:"path"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Error string `json:"error,omitempty"`
}

// InspectPaths 判断拖入的路径是文件还是目录，供前端区分处理
func (a *App) InspectPaths(paths []string) []PathKind {
	out := make([]PathKind, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		k := PathKind{Path: p}
		st, err := os.Stat(p)
		if err != nil {
			k.Error = err.Error()
			out = append(out, k)
			continue
		}
		k.Dir = st.IsDir()
		if !k.Dir {
			k.Size = st.Size()
		}
		out = append(out, k)
	}
	return out
}

// ---------------------------------------------------------------- 任务

// StartJobResult 任务启动结果
type StartJobResult struct {
	JobID string `json:"jobId"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// JobDone 任务完成事件负载
type JobDone struct {
	JobID string       `json:"jobId"`
	Kind  string       `json:"kind"`
	OK    bool         `json:"ok"`
	Error string       `json:"error,omitempty"`
	Scan  *ScanResult  `json:"scan,omitempty"`
	Check *CheckResult `json:"check,omitempty"`
}

func (a *App) emitProgress(p JobProgress) {
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "job:progress", p)
	}
}

func (a *App) emitDone(d JobDone) {
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "job:done", d)
	}
}

func (a *App) register(jobID string, cancel context.CancelFunc) {
	a.mu.Lock()
	a.jobs[jobID] = cancel
	a.order = append(a.order, jobID)
	// 保留最近 30 个任务
	for len(a.order) > 30 {
		old := a.order[0]
		a.order = a.order[1:]
		delete(a.jobs, old)
		delete(a.scans, old)
		delete(a.checks, old)
	}
	a.mu.Unlock()
}

func (a *App) unregister(jobID string) {
	a.mu.Lock()
	delete(a.jobs, jobID)
	a.mu.Unlock()
}

// CancelJob 取消任务
func (a *App) CancelJob(jobID string) OpResult {
	a.mu.Lock()
	c, ok := a.jobs[jobID]
	a.mu.Unlock()
	if !ok {
		return OpResult{OK: false, Message: "任务不存在或已结束"}
	}
	c()
	return OpResult{OK: true, Message: "已请求取消"}
}

// ---------------------------------------------------------------- 目录扫描

// StartScan 启动目录扫描（支持一次扫描多个目录，结果合并为一份）
func (a *App) StartScan(req ScanRequest) StartJobResult {
	if a.store == nil {
		return StartJobResult{OK: false, Error: "数据目录未就绪"}
	}
	roots := scanRoots(req)
	if len(roots) == 0 {
		return StartJobResult{OK: false, Error: "请先选择目录"}
	}
	// 根目录既可以是目录，也可以是单个文件
	valid := make([]string, 0, len(roots))
	bad := make([]string, 0)
	for _, r := range roots {
		st, err := os.Stat(r)
		if err != nil || (!st.IsDir() && !st.Mode().IsRegular()) {
			bad = append(bad, r)
			continue
		}
		valid = append(valid, r)
	}
	if len(bad) > 0 {
		return StartJobResult{OK: false, Error: "路径不存在或不可访问：" + strings.Join(bad, "、")}
	}
	req.Roots = valid
	req.Root = valid[0]

	jobID := newID()
	ctx, cancel := context.WithCancel(context.Background())
	a.register(jobID, cancel)

	var base *MD5List
	if req.BaseListID != "" {
		if l, err := a.loadListCached(req.BaseListID); err == nil {
			base = l
		}
	}

	go func() {
		defer func() {
			a.unregister(jobID)
			cancel()
		}()
		emit := func(p JobProgress) {
			p.JobID = jobID
			a.emitProgress(p)
		}
		res, sess, err := runScan(ctx, req, a.cfg, emit, base)
		if err != nil {
			a.emitDone(JobDone{JobID: jobID, Kind: "scan", OK: false, Error: err.Error()})
			return
		}
		res.JobID = jobID

		a.mu.Lock()
		a.scans[jobID] = sess
		a.lastKey["scan"] = jobID
		a.mu.Unlock()

		if res.OK && req.Archive {
			listID, listName, aerr := a.archiveScan(req, sess)
			if aerr != nil {
				res.Errors++
			} else {
				res.ListID = listID
				res.ListName = listName
			}
		}

		a.emitDone(JobDone{JobID: jobID, Kind: "scan", OK: res.OK, Error: res.Error, Scan: res})
	}()

	return StartJobResult{JobID: jobID, OK: true}
}

// archiveScan 把扫描结果存档为 MD5 列表（新建或叠加）
func (a *App) archiveScan(req ScanRequest, sess *scanSession) (string, string, error) {
	entries := entriesFromRows(sess.Rows)
	roots := sess.Roots
	if len(roots) == 0 {
		roots = scanRoots(req)
	}
	source := strings.Join(roots, "; ")
	name := strings.TrimSpace(req.SaveAs)
	if name == "" {
		switch {
		case len(roots) == 0:
			name = "扫描 " + time.Now().Format("01-02 15:04")
		case len(roots) == 1:
			name = filepath.Base(strings.TrimRight(roots[0], `\/`)) + " " + time.Now().Format("01-02 15:04")
		default:
			name = filepath.Base(strings.TrimRight(roots[0], `\/`)) + " 等 " +
				strconv.Itoa(len(roots)) + " 个目录 " + time.Now().Format("01-02 15:04")
		}
	}
	layer := Layer{
		ID: newID(), Name: name, Note: req.Note, Source: source,
		AddedAt: time.Now(), Count: len(entries), Added: len(entries),
	}

	if req.BaseListID != "" {
		target, err := a.loadListFresh(req.BaseListID)
		if err != nil {
			return "", "", err
		}
		src := &MD5List{Entries: entries}
		added, merged := target.MergeIn(src, layer)
		target.Layers[len(target.Layers)-1].Added = added
		target.Layers[len(target.Layers)-1].Merged = merged
		_ = roots // 来源路径不再记录
		if req.Note != "" {
			target.Note = req.Note
		}
		target.Dedupe() // 叠加后自动去重，列表里不保留重复 MD5
		target.RebuildLayersCount()
		if err := a.store.SaveList(target); err != nil {
			return "", "", err
		}
		a.invalidate(target.ID)
		return target.ID, target.Name, nil
	}

	l := &MD5List{
		ListMeta: ListMeta{
			ID: newID(), Name: name, Note: req.Note,
			CreatedAt: time.Now(), UpdatedAt: time.Now(),
			Layers: []Layer{layer},
		},
		Entries: entries,
	}
	l.Dedupe()
	if err := a.store.SaveList(l); err != nil {
		return "", "", err
	}
	return l.ID, l.Name, nil
}

// entriesFromCheck 把查重结果按 MD5 归并成条目
func entriesFromCheck(items []CheckItem, onlyMatched bool) []Entry {
	idx := make(map[string]int, len(items))
	out := make([]Entry, 0, len(items))
	for _, it := range items {
		if it.MD5 == "" || it.Error != "" {
			continue
		}
		if onlyMatched && !it.Matched {
			continue
		}
		if i, ok := idx[it.MD5]; ok {
			out[i].Paths = append(out[i].Paths, PathRef{Path: it.Path})
			continue
		}
		idx[it.MD5] = len(out)
		out = append(out, Entry{
			MD5: it.MD5, Size: it.Size,
			Paths: []PathRef{{Path: it.Path}},
		})
	}
	return out
}

// ArchiveCheck 把查重结果存档为 MD5 列表（新建或叠加到已有列表）
func (a *App) ArchiveCheck(req CheckArchiveRequest) OpResult {
	if a.store == nil {
		return OpResult{OK: false, Message: "数据目录未就绪"}
	}
	a.mu.Lock()
	sess := a.checks[req.JobID]
	a.mu.Unlock()
	if sess == nil {
		return OpResult{OK: false, Message: "查重结果已失效，请重新查重"}
	}
	entries := entriesFromCheck(sess.Items, req.OnlyMatched)
	if len(entries) == 0 {
		return OpResult{OK: false, Message: "没有可存档的条目"}
	}

	name := strings.TrimSpace(req.SaveAs)
	if name == "" {
		name = "查重结果 " + time.Now().Format("01-02 15:04")
	}
	layer := Layer{
		ID: newID(), Name: name, Note: req.Note, Source: "查重",
		AddedAt: time.Now(), Count: len(entries), Added: len(entries),
	}

	if req.TargetID != "" {
		target, err := a.loadListFresh(req.TargetID)
		if err != nil {
			return OpResult{OK: false, Message: "目标列表读取失败"}
		}
		src := &MD5List{Entries: entries}
		added, merged := target.MergeIn(src, layer)
		target.Layers[len(target.Layers)-1].Added = added
		target.Layers[len(target.Layers)-1].Merged = merged
		if req.Note != "" {
			target.Note = req.Note
		}
		target.Dedupe()
		target.RebuildLayersCount()
		if err := a.store.SaveList(target); err != nil {
			return OpResult{OK: false, Message: err.Error()}
		}
		a.invalidate(target.ID)
		return OpResult{
			OK: true, Added: added, Merged: merged, Count: len(target.Entries), ListID: target.ID,
			Message: "已叠加到「" + target.Name + "」：新增 " + strconv.Itoa(added) + " 条，合并 " + strconv.Itoa(merged) + " 条",
		}
	}

	l := &MD5List{
		ListMeta: ListMeta{
			ID: newID(), Name: name, Note: req.Note,
			CreatedAt: time.Now(), UpdatedAt: time.Now(),
			Layers: []Layer{layer},
		},
		Entries: entries,
	}
	l.Dedupe()
	l.RebuildLayersCount()
	if err := a.store.SaveList(l); err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	return OpResult{
		OK: true, Added: len(l.Entries), Count: len(l.Entries), ListID: l.ID,
		Message: "已新建列表「" + name + "」：" + strconv.Itoa(len(l.Entries)) + " 条",
	}
}

// entriesFromRows 把文件行按 MD5 归并成条目
func entriesFromRows(rows []fileRow) []Entry {
	idx := map[string]int{}
	out := make([]Entry, 0, len(rows)/2+1)
	for _, r := range rows {
		if r.MD5 == "" {
			continue
		}
		if i, ok := idx[r.MD5]; ok {
			out[i].Paths = append(out[i].Paths, PathRef{Path: r.Path, MTime: r.MTime})
			continue
		}
		idx[r.MD5] = len(out)
		out = append(out, Entry{
			MD5: r.MD5, Size: r.Size,
			Paths: []PathRef{{Path: r.Path, MTime: r.MTime}},
		})
	}
	return out
}

// ScanPage 分页查询扫描结果
func (a *App) ScanPage(q PageQuery) Page {
	a.mu.Lock()
	sess := a.scans[q.Key]
	a.mu.Unlock()
	if sess == nil {
		return Page{Items: []fileRow{}}
	}
	rows := filterRows(sess.Rows, q)
	sortRows(rows, q.Sort, q.Desc)
	return pageOf(rows, q)
}

// ScanGroups 分页查询重复组
func (a *App) ScanGroups(q PageQuery) Page {
	a.mu.Lock()
	sess := a.scans[q.Key]
	a.mu.Unlock()
	if sess == nil {
		return Page{Items: []DupGroup{}}
	}
	groups := sess.Groups
	if s := strings.TrimSpace(strings.ToLower(q.Query)); s != "" {
		out := make([]DupGroup, 0, len(groups))
		for _, g := range groups {
			if strings.Contains(strings.ToLower(g.MD5), s) {
				out = append(out, g)
				continue
			}
			for _, p := range g.Paths {
				if strings.Contains(strings.ToLower(p.Path), s) {
					out = append(out, g)
					break
				}
			}
		}
		groups = out
	}
	return pageOf(groups, q)
}

// LastJob 返回最近一次任务的 ID
func (a *App) LastJob(kind string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastKey[kind]
}

// ---------------------------------------------------------------- 文件查重

// StartCheck 启动查重
func (a *App) StartCheck(req CheckRequest) StartJobResult {
	if a.store == nil {
		return StartJobResult{OK: false, Error: "数据目录未就绪"}
	}
	if len(req.ListIDs) == 0 {
		return StartJobResult{OK: false, Error: "请选择基准列表"}
	}
	if len(req.Targets) == 0 {
		return StartJobResult{OK: false, Error: "请选择待查对象"}
	}

	lists := make([]*MD5List, 0, len(req.ListIDs))
	names := make([]string, 0, len(req.ListIDs))
	for _, id := range req.ListIDs {
		l, err := a.loadListCached(id)
		if err != nil {
			continue
		}
		lists = append(lists, l)
		names = append(names, l.Name)
	}
	if len(lists) == 0 {
		return StartJobResult{OK: false, Error: "基准列表读取失败"}
	}
	index := buildIndex(lists)

	jobID := newID()
	ctx, cancel := context.WithCancel(context.Background())
	a.register(jobID, cancel)

	go func() {
		defer func() {
			a.unregister(jobID)
			cancel()
		}()
		emit := func(p JobProgress) {
			p.JobID = jobID
			a.emitProgress(p)
		}
		res, sess, err := runCheck(ctx, req, a.cfg, emit, index, names)
		if err != nil {
			a.emitDone(JobDone{JobID: jobID, Kind: "check", OK: false, Error: err.Error()})
			return
		}
		res.JobID = jobID
		a.mu.Lock()
		a.checks[jobID] = sess
		a.lastKey["check"] = jobID
		a.mu.Unlock()
		a.emitDone(JobDone{JobID: jobID, Kind: "check", OK: res.OK, Error: res.Error, Check: res})
	}()

	return StartJobResult{JobID: jobID, OK: true}
}

// CheckPage 分页查询查重结果
func (a *App) CheckPage(q PageQuery) Page {
	a.mu.Lock()
	sess := a.checks[q.Key]
	a.mu.Unlock()
	if sess == nil {
		return Page{Items: []CheckItem{}}
	}
	items := sess.Items
	switch q.Filter {
	case "dup", "matched":
		items = filterCheck(items, true)
	case "unique":
		items = filterCheck(items, false)
	}
	if s := strings.TrimSpace(strings.ToLower(q.Query)); s != "" {
		out := make([]CheckItem, 0, len(items))
		for _, it := range items {
			if strings.Contains(strings.ToLower(it.Path), s) ||
				strings.Contains(strings.ToLower(it.MD5), s) ||
				strings.Contains(strings.ToLower(it.MatchPath), s) {
				out = append(out, it)
			}
		}
		items = out
	}
	if q.Sort == "size" {
		sort.SliceStable(items, func(i, j int) bool {
			if q.Desc {
				return items[i].Size > items[j].Size
			}
			return items[i].Size < items[j].Size
		})
	}
	return pageOf(items, q)
}

// CheckAllMatched 返回全部命中项（用于批量操作）
func (a *App) CheckAllMatched(jobID string) []string {
	a.mu.Lock()
	sess := a.checks[jobID]
	a.mu.Unlock()
	if sess == nil {
		return []string{}
	}
	out := make([]string, 0, sess.Result.Matched)
	for _, it := range sess.Items {
		if it.Matched {
			out = append(out, it.Path)
		}
	}
	return out
}

// TrashRequest 移入回收站请求
type TrashRequest struct {
	Paths  []string `json:"paths"`
	JobID  string   `json:"jobId"`
	DryRun bool     `json:"dryRun"`
}

// MoveToTrash 把文件移入回收站
func (a *App) MoveToTrash(req TrashRequest) TrashResult {
	if len(req.Paths) == 0 {
		return TrashResult{Errors: []string{}}
	}
	if req.DryRun {
		var freed int64
		for _, p := range req.Paths {
			if st, err := os.Stat(p); err == nil {
				freed += st.Size()
			}
		}
		return TrashResult{Moved: 0, Freed: freed, Errors: []string{}, DryRun: true}
	}

	// 从查重会话补齐 MD5 / 大小信息
	items := map[string]CheckItem{}
	a.mu.Lock()
	sess := a.checks[req.JobID]
	a.mu.Unlock()
	if sess != nil {
		for _, it := range sess.Items {
			items[strings.ToLower(it.Path)] = it
		}
	}
	return a.moveToTrash(req.Paths, items)
}

// ---------------------------------------------------------------- 列表管理

// loadListCached 读取列表（带文件修改时间校验的缓存）
func (a *App) loadListCached(id string) (*MD5List, error) {
	if a.store == nil {
		return nil, fmt.Errorf("数据目录未就绪")
	}
	if id == "" {
		return nil, fmt.Errorf("缺少列表 ID")
	}
	path := filepath.Join(a.store.ListsDir(), id+".json")
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	a.cmu.Lock()
	defer a.cmu.Unlock()
	if ce, ok := a.lcache[id]; ok && ce.mod.Equal(st.ModTime()) {
		return ce.list, nil
	}
	l, err := a.store.LoadList(id)
	if err != nil {
		return nil, err
	}
	a.lcache[id] = listCacheEntry{list: l, mod: st.ModTime()}
	return l, nil
}

// loadListFresh 直接读盘，用于后台写操作，避免与读缓存共享指针
func (a *App) loadListFresh(id string) (*MD5List, error) {
	if a.store == nil {
		return nil, fmt.Errorf("数据目录未就绪")
	}
	return a.store.LoadList(id)
}

func (a *App) invalidate(id string) {
	a.cmu.Lock()
	delete(a.lcache, id)
	a.cmu.Unlock()
}

// ListMetas 全部列表元信息
func (a *App) ListMetas() ([]ListMeta, error) {
	if a.store == nil {
		return []ListMeta{}, fmt.Errorf("数据目录未就绪")
	}
	return a.store.ListMetas()
}

// GetListMeta 单个列表元信息
func (a *App) GetListMeta(id string) (*ListMeta, error) {
	l, err := a.loadListCached(id)
	if err != nil {
		return nil, err
	}
	m := l.ListMeta
	return &m, nil
}

// ListPage 分页查询列表条目
func (a *App) ListPage(q PageQuery) Page {
	l, err := a.loadListCached(q.Key)
	if err != nil {
		return Page{Items: []Entry{}}
	}
	entries := l.Entries
	if q.Layer != "" {
		out := make([]Entry, 0, len(entries))
		for _, e := range entries {
			for _, ly := range e.Layers {
				if ly == q.Layer {
					out = append(out, e)
					break
				}
			}
		}
		entries = out
	}
	if s := strings.TrimSpace(strings.ToLower(q.Query)); s != "" {
		out := make([]Entry, 0, len(entries))
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.MD5), s) ||
				strings.Contains(strings.ToLower(e.Note), s) {
				out = append(out, e)
				continue
			}
			for _, p := range e.Paths {
				if strings.Contains(strings.ToLower(p.Path), s) {
					out = append(out, e)
					break
				}
			}
		}
		entries = out
	}
	switch q.Sort {
	case "size":
		sort.SliceStable(entries, func(i, j int) bool {
			if q.Desc {
				return entries[i].Size > entries[j].Size
			}
			return entries[i].Size < entries[j].Size
		})
	case "count":
		sort.SliceStable(entries, func(i, j int) bool {
			if q.Desc {
				return len(entries[i].Paths) > len(entries[j].Paths)
			}
			return len(entries[i].Paths) < len(entries[j].Paths)
		})
	case "md5":
		sort.SliceStable(entries, func(i, j int) bool {
			if q.Desc {
				return entries[i].MD5 > entries[j].MD5
			}
			return entries[i].MD5 < entries[j].MD5
		})
	}
	return pageOf(entries, q)
}

// RenameList 修改名称与备注
func (a *App) RenameList(id, name, note string) OpResult {
	l, err := a.loadListFresh(id)
	if err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	if strings.TrimSpace(name) != "" {
		l.Name = strings.TrimSpace(name)
	}
	l.Note = note
	if err := a.store.SaveList(l); err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	a.invalidate(id)
	return OpResult{OK: true, Message: "已保存", ListID: id}
}

// DeleteList 删除列表
func (a *App) DeleteList(id string) OpResult {
	if err := a.store.DeleteList(id); err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	return OpResult{OK: true, Message: "已删除"}
}

// CopyList 另存一份
func (a *App) CopyList(id, name string) OpResult {
	l, err := a.store.CopyList(id, name)
	if err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	return OpResult{OK: true, Message: "已另存为「" + l.Name + "」", ListID: l.ID, Count: l.Count}
}

// MergeLists 把来源列表叠加到目标列表
func (a *App) MergeLists(req MergeRequest) OpResult {
	target, err := a.loadListFresh(req.TargetID)
	if err != nil {
		return OpResult{OK: false, Message: "目标列表读取失败"}
	}
	src, err := a.loadListFresh(req.SourceID)
	if err != nil {
		return OpResult{OK: false, Message: "来源列表读取失败"}
	}
	if target.ID == src.ID {
		return OpResult{OK: false, Message: "不能叠加自身"}
	}
	name := strings.TrimSpace(req.LayerName)
	if name == "" {
		name = src.Name
	}
	layer := Layer{ID: newID(), Name: name, Note: req.Note, Source: src.Name,
		AddedAt: time.Now(), Count: src.Count}
	added, merged := target.MergeIn(src, layer)
	target.Layers[len(target.Layers)-1].Added = added
	target.Layers[len(target.Layers)-1].Merged = merged
	target.Dedupe() // 叠加后自动去重
	target.RebuildLayersCount()
	if err := a.store.SaveList(target); err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	a.invalidate(target.ID)
	return OpResult{OK: true, Added: added, Merged: merged, ListID: target.ID,
		Message: fmt.Sprintf("新增 %d 条，合并 %d 条", added, merged)}
}

// ExportList 导出列表
func (a *App) ExportList(id, format, dest string) (string, error) {
	return a.store.ExportList(id, format, dest)
}

// ImportList 导入列表
func (a *App) ImportList(path string) OpResult {
	l, err := a.store.ImportList(path)
	if err != nil {
		return OpResult{OK: false, Message: err.Error()}
	}
	return OpResult{OK: true, Message: "已导入「" + l.Name + "」", ListID: l.ID, Count: l.Count}
}

// ---------------------------------------------------------------- 回收站日志

// TrashLog 读取回收站操作日志
func (a *App) TrashLog(limit int) ([]TrashLogItem, error) {
	if a.store == nil {
		return []TrashLogItem{}, fmt.Errorf("数据目录未就绪")
	}
	return a.store.ReadTrashLog(limit)
}

// ---------------------------------------------------------------- 辅助

func pageOf[T any](items []T, q PageQuery) Page {
	total := len(items)
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	end := offset + limit
	if end > total {
		end = total
	}
	slice := items[offset:end]
	if slice == nil {
		slice = []T{}
	}
	return Page{Total: total, Offset: offset, Limit: limit, Items: slice}
}

func filterRows(rows []fileRow, q PageQuery) []fileRow {
	out := rows
	switch q.Filter {
	case "dup":
		out = make([]fileRow, 0, len(rows))
		for _, r := range rows {
			if r.Dup {
				out = append(out, r)
			}
		}
	case "error":
		out = make([]fileRow, 0)
		for _, r := range rows {
			if r.Error != "" {
				out = append(out, r)
			}
		}
	}
	if s := strings.TrimSpace(strings.ToLower(q.Query)); s != "" {
		f := make([]fileRow, 0, len(out))
		for _, r := range out {
			if strings.Contains(strings.ToLower(r.Path), s) ||
				strings.Contains(strings.ToLower(r.MD5), s) {
				f = append(f, r)
			}
		}
		out = f
	}
	return out
}

func sortRows(rows []fileRow, by string, desc bool) {
	switch by {
	case "size":
		sort.SliceStable(rows, func(i, j int) bool {
			if desc {
				return rows[i].Size > rows[j].Size
			}
			return rows[i].Size < rows[j].Size
		})
	case "md5":
		sort.SliceStable(rows, func(i, j int) bool {
			if desc {
				return rows[i].MD5 > rows[j].MD5
			}
			return rows[i].MD5 < rows[j].MD5
		})
	default:
		sort.SliceStable(rows, func(i, j int) bool {
			if desc {
				return strings.ToLower(rows[i].Path) > strings.ToLower(rows[j].Path)
			}
			return strings.ToLower(rows[i].Path) < strings.ToLower(rows[j].Path)
		})
	}
}

func filterCheck(items []CheckItem, matched bool) []CheckItem {
	out := make([]CheckItem, 0, len(items))
	for _, it := range items {
		if it.Matched == matched {
			out = append(out, it)
		}
	}
	return out
}
