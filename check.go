package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// matchInfo 基准列表中的命中信息
type matchInfo struct {
	ListName string
	Path     string
	Size     int64
}

type checkSession struct {
	Items  []CheckItem
	Result CheckResult
}

// buildIndex 把若干列表合并成 md5 -> 命中信息 的索引
func buildIndex(lists []*MD5List) map[string]matchInfo {
	idx := make(map[string]matchInfo)
	for _, l := range lists {
		if l == nil {
			continue
		}
		for _, e := range l.Entries {
			if _, ok := idx[e.MD5]; ok {
				continue
			}
			idx[e.MD5] = matchInfo{ListName: l.Name, Path: e.Primary(), Size: e.Size}
		}
	}
	return idx
}

// runCheck 对一批目标做查重
func runCheck(ctx context.Context, req CheckRequest, cfg Config, emit func(JobProgress),
	index map[string]matchInfo, listNames []string) (*CheckResult, *checkSession, error) {

	started := time.Now()
	res := &CheckResult{Lists: listNames}
	sess := &checkSession{}

	emitP := func(p JobProgress) {
		p.Kind = "check"
		p.ElapsedMs = time.Since(started).Milliseconds()
		emit(p)
	}

	w := newWalker(req.Recursive, req.SkipHidden, req.MinSize, req.Exclude)
	w.onTick = func(n int) {
		if n%500 == 0 {
			emitP(JobProgress{Phase: "walking", Total: n, Done: n})
		}
	}
	w.run(req.Targets)

	if ctx.Err() != nil {
		res.OK, res.Error = false, "已取消"
		return res, sess, nil
	}

	files := w.files
	total := len(files)
	emitP(JobProgress{Phase: "hashing", Total: total})

	hashes, errList, _, _ := hashAll(ctx, files, cfg.Concurrency, nil,
		func(done int, bytes int64) {
			emitP(JobProgress{Phase: "hashing", Total: total, Done: done, Bytes: bytes})
		})

	if ctx.Err() != nil {
		res.OK, res.Error = false, "已取消"
		return res, sess, nil
	}

	errMap := make(map[string]string, len(errList))
	for _, e := range errList {
		if i := strings.LastIndex(e, ": "); i > 0 {
			errMap[e[:i]] = e[i+2:]
		}
	}

	items := make([]CheckItem, 0, total)
	var matched int
	var matchSize int64
	for i, f := range files {
		it := CheckItem{Path: f.Path, Size: f.Size, MD5: hashes[i]}
		if msg, ok := errMap[f.Path]; ok {
			it.Error = msg
		}
		if hashes[i] != "" {
			if m, ok := index[hashes[i]]; ok && m.Size == f.Size {
				it.Matched = true
				it.MatchPath = m.Path
				it.MatchList = m.ListName
				matched++
				matchSize += f.Size
			}
		}
		items = append(items, it)
	}

	// 重复项排前面，其次按路径
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].Matched != items[b].Matched {
			return items[a].Matched
		}
		return strings.ToLower(items[a].Path) < strings.ToLower(items[b].Path)
	})

	sess.Items = items

	res.OK = true
	res.Total = total
	res.Matched = matched
	res.Unique = total - matched
	res.MatchSize = matchSize
	res.Errors = len(errList)
	res.ElapsedMs = time.Since(started).Milliseconds()

	emitP(JobProgress{Phase: "done", Total: total, Done: total})
	return res, sess, nil
}

// moveToTrash 把文件移入回收站，并记录日志
func (a *App) moveToTrash(paths []string, items map[string]CheckItem) TrashResult {
	out := TrashResult{Errors: []string{}}
	if len(paths) == 0 {
		return out
	}
	moved, errs := recycleFiles(paths)
	out.Moved = moved
	out.Failed = len(errs)
	out.Errors = errs
	if len(out.Errors) > 200 {
		out.Errors = out.Errors[:200]
	}

	logs := make([]TrashLogItem, 0, len(paths))
	for _, p := range paths {
		it := items[strings.ToLower(p)]
		out.Freed += it.Size
		logs = append(logs, TrashLogItem{
			Time: time.Now(), Path: p, MD5: it.MD5, Size: it.Size, Source: it.MatchList,
		})
	}
	if err := a.store.AppendTrashLog(logs); err != nil {
		out.Errors = append(out.Errors, fmt.Sprintf("日志写入失败: %v", err))
	}
	return out
}
