package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanFindsDuplicates(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "hello")
	write(t, filepath.Join(dir, "b.txt"), "hello")
	write(t, filepath.Join(dir, "c.txt"), "world")
	write(t, filepath.Join(dir, "sub", "d.txt"), "hello")
	write(t, filepath.Join(dir, "sub", "e.txt"), "unique-content")

	cfg := defaultConfig()
	res, sess, err := runScan(context.Background(),
		ScanRequest{Root: dir, Options: ScanOptions{}}, cfg, func(JobProgress) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("扫描失败: %s", res.Error)
	}
	if res.Files != 5 {
		t.Fatalf("文件数 = %d, 期望 5", res.Files)
	}
	if res.Unique != 3 {
		t.Fatalf("唯一 MD5 = %d, 期望 3", res.Unique)
	}
	if res.Groups != 1 {
		t.Fatalf("重复组 = %d, 期望 1", res.Groups)
	}
	if res.DupFiles != 3 {
		t.Fatalf("重复文件 = %d, 期望 3", res.DupFiles)
	}
	if res.Waste != 10 {
		t.Fatalf("可释放 = %d, 期望 10", res.Waste)
	}
	if len(sess.Rows) != 5 {
		t.Fatalf("会话行数 = %d", len(sess.Rows))
	}

	// 归档为条目
	entries := entriesFromRows(sess.Rows)
	if len(entries) != 3 {
		t.Fatalf("条目数 = %d, 期望 3", len(entries))
	}
	for _, e := range entries {
		if e.MD5 == "" {
			t.Fatal("存在空 MD5")
		}
		if len(e.Paths) == 0 {
			t.Fatal("条目缺少路径")
		}
	}
}

func TestScanExcludeAndMinSize(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "keep.txt"), "keep")
	write(t, filepath.Join(dir, "skip.tmp"), "skip")
	write(t, filepath.Join(dir, "node_modules", "x.js"), "x")
	write(t, filepath.Join(dir, "tiny.bin"), "1")

	cfg := defaultConfig()
	res, _, err := runScan(context.Background(), ScanRequest{
		Root:    dir,
		Options: ScanOptions{Exclude: []string{"*.tmp", "node_modules"}, MinSize: 2},
	}, cfg, func(JobProgress) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 1 {
		t.Fatalf("文件数 = %d, 期望 1", res.Files)
	}
}

func TestScanMultipleRoots(t *testing.T) {
	d1 := t.TempDir()
	d2 := t.TempDir()
	write(t, filepath.Join(d1, "a.txt"), "hello")
	write(t, filepath.Join(d1, "b.txt"), "unique-1")
	write(t, filepath.Join(d2, "c.txt"), "hello") // 与 d1 的 a.txt 内容相同
	write(t, filepath.Join(d2, "sub", "d.txt"), "unique-2")

	cfg := defaultConfig()
	res, sess, err := runScan(context.Background(), ScanRequest{
		Roots:   []string{d1, d2},
		Options: ScanOptions{},
	}, cfg, func(JobProgress) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("扫描失败: %s", res.Error)
	}
	if res.Files != 4 {
		t.Fatalf("文件数 = %d, 期望 4", res.Files)
	}
	if res.Groups != 1 {
		t.Fatalf("跨目录重复组 = %d, 期望 1", res.Groups)
	}
	if res.DupFiles != 2 {
		t.Fatalf("重复文件 = %d, 期望 2", res.DupFiles)
	}
	if len(res.Roots) != 2 {
		t.Fatalf("结果根目录数 = %d, 期望 2", len(res.Roots))
	}
	if len(sess.Rows) != 4 {
		t.Fatalf("会话行数 = %d, 期望 4", len(sess.Rows))
	}

	// 重复 / 空白的根目录应被归一化掉
	dup := scanRoots(ScanRequest{Roots: []string{d1, d1, "  "}, Root: d1})
	if len(dup) != 1 {
		t.Fatalf("根目录去重失败: %v", dup)
	}
	// 只用旧的单目录字段也应工作
	only := scanRoots(ScanRequest{Root: d1})
	if len(only) != 1 || only[0] != d1 {
		t.Fatalf("单目录兼容失败: %v", only)
	}
}

func TestIncrementalReuse(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.txt"), "hello")
	write(t, filepath.Join(dir, "b.txt"), "world")

	cfg := defaultConfig()
	res1, sess1, _ := runScan(context.Background(),
		ScanRequest{Root: dir, Options: ScanOptions{}}, cfg, func(JobProgress) {}, nil)
	if res1.Skipped != 0 {
		t.Fatalf("首次扫描不应有复用, 得到 %d", res1.Skipped)
	}

	base := &MD5List{Entries: entriesFromRows(sess1.Rows)}
	res2, _, _ := runScan(context.Background(),
		ScanRequest{Root: dir, Options: ScanOptions{}, Incremental: true}, cfg, func(JobProgress) {}, base)
	if res2.Skipped != 2 {
		t.Fatalf("增量复用 = %d, 期望 2", res2.Skipped)
	}
	if res2.Unique != res1.Unique {
		t.Fatalf("增量结果应与首次一致: %d vs %d", res2.Unique, res1.Unique)
	}
}

func TestListDedupeAndMerge(t *testing.T) {
	a := &MD5List{Entries: []Entry{
		{MD5: "m1", Size: 10, Paths: []PathRef{{Path: "p1"}}},
		{MD5: "m2", Size: 20, Paths: []PathRef{{Path: "p2"}}},
		{MD5: "m1", Size: 10, Paths: []PathRef{{Path: "p3"}}},
	}}
	removed, _ := a.Dedupe()
	if removed != 1 {
		t.Fatalf("去重移除 = %d, 期望 1", removed)
	}
	if len(a.Entries) != 2 {
		t.Fatalf("去重后条目 = %d, 期望 2", len(a.Entries))
	}
	for _, e := range a.Entries {
		if e.MD5 == "m1" && len(e.Paths) != 2 {
			t.Fatalf("m1 路径应合并为 2, 得到 %d", len(e.Paths))
		}
	}

	b := &MD5List{Entries: []Entry{
		{MD5: "m2", Size: 20, Paths: []PathRef{{Path: "q2"}}},
		{MD5: "m3", Size: 30, Paths: []PathRef{{Path: "q3"}}},
	}}
	added, merged := a.MergeIn(b, Layer{ID: "L1", Name: "第二批"})
	if added != 1 || merged != 1 {
		t.Fatalf("叠加结果 added=%d merged=%d, 期望 1/1", added, merged)
	}
	if len(a.Entries) != 3 {
		t.Fatalf("叠加后条目 = %d, 期望 3", len(a.Entries))
	}
	if len(a.Layers) != 1 {
		t.Fatalf("层数 = %d, 期望 1", len(a.Layers))
	}
}

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &Store{}
	if err := s.initUnder(dir); err != nil {
		t.Fatal(err)
	}
	if s.DataDir() != filepath.Join(dir, "data") {
		t.Fatalf("数据目录 = %s", s.DataDir())
	}

	l := &MD5List{
		ListMeta: ListMeta{ID: newID(), Name: "测试列表", Note: "备注"},
		Entries:  []Entry{{MD5: "abc", Size: 3, Paths: []PathRef{{Path: "x", MTime: 1}}}},
	}
	if err := s.SaveList(l); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadList(l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "测试列表" || got.Count != 1 || got.TotalSize != 3 {
		t.Fatalf("回读不一致: %+v", got.ListMeta)
	}
	metas, err := s.ListMetas()
	if err != nil || len(metas) != 1 {
		t.Fatalf("列表元信息数量 = %d, err=%v", len(metas), err)
	}
	cp, err := s.CopyList(l.ID, "副本")
	if err != nil {
		t.Fatal(err)
	}
	if cp.ID == l.ID || cp.Name != "副本" {
		t.Fatal("另存为失败")
	}
	if out, err := s.ExportList(l.ID, "csv", filepath.Join(dir, "out.csv")); err != nil {
		t.Fatalf("导出 CSV 失败: %v", err)
	} else if _, err := os.Stat(out); err != nil {
		t.Fatal("CSV 未生成")
	}
	if err := s.DeleteList(l.ID); err != nil {
		t.Fatal(err)
	}
}

func TestRunCheckAgainstList(t *testing.T) {
	base := t.TempDir()
	write(t, filepath.Join(base, "keep.txt"), "shared-content")
	write(t, filepath.Join(base, "only.txt"), "only-here")

	cfg := defaultConfig()
	_, sess, _ := runScan(context.Background(),
		ScanRequest{Root: base, Options: ScanOptions{}}, cfg, func(JobProgress) {}, nil)
	list := &MD5List{ListMeta: ListMeta{Name: "基准"}, Entries: entriesFromRows(sess.Rows)}
	index := buildIndex([]*MD5List{list})

	inbox := t.TempDir()
	write(t, filepath.Join(inbox, "dup1.txt"), "shared-content")
	write(t, filepath.Join(inbox, "dup2.txt"), "shared-content")
	write(t, filepath.Join(inbox, "new.txt"), "brand-new")

	res, csess, err := runCheck(context.Background(), CheckRequest{
		Targets: []string{inbox}, Recursive: true,
	}, cfg, func(JobProgress) {}, index, []string{"基准"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("查重失败: %s", res.Error)
	}
	if res.Total != 3 || res.Matched != 2 || res.Unique != 1 {
		t.Fatalf("查重统计 total=%d matched=%d unique=%d", res.Total, res.Matched, res.Unique)
	}
	// 命中项应排在前面
	if !csess.Items[0].Matched || !csess.Items[1].Matched {
		t.Fatal("命中项未排在前面")
	}
	if csess.Items[0].MatchList != "基准" {
		t.Fatalf("命中列表名 = %s", csess.Items[0].MatchList)
	}
}

func TestBuildIndexSizeGuard(t *testing.T) {
	l := &MD5List{ListMeta: ListMeta{Name: "L"}, Entries: []Entry{{MD5: "x", Size: 5, Paths: []PathRef{{Path: "p"}}}}}
	idx := buildIndex([]*MD5List{l})
	if m, ok := idx["x"]; !ok || m.Size != 5 {
		t.Fatal("索引构建失败")
	}
}
