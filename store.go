package main

import (
	"bufio"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Store 负责 data 目录下的全部持久化
type Store struct {
	exeDir   string
	dataDir  string
	listsDir string
}

// NewStore 在「程序运行目录」下建立 data 目录
func NewStore() (*Store, error) {
	exe, err := os.Executable()
	var exeDir string
	if err == nil {
		exeDir = filepath.Dir(exe)
	} else {
		exeDir, _ = os.Getwd()
	}

	s := &Store{exeDir: exeDir}

	if err := s.initUnder(exeDir); err != nil {
		// 程序目录不可写时退回到当前工作目录
		wd, e2 := os.Getwd()
		if e2 != nil {
			return nil, err
		}
		if err2 := s.initUnder(wd); err2 != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) initUnder(base string) error {
	dataDir := filepath.Join(base, "data")
	listsDir := filepath.Join(dataDir, "lists")
	if err := os.MkdirAll(listsDir, 0o755); err != nil {
		return err
	}
	// 可写性探测
	probe := filepath.Join(dataDir, ".probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return err
	}
	_ = os.Remove(probe)
	s.dataDir = dataDir
	s.listsDir = listsDir
	return nil
}

func (s *Store) DataDir() string  { return s.dataDir }
func (s *Store) ExeDir() string   { return s.exeDir }
func (s *Store) ListsDir() string { return s.listsDir }

func (s *Store) listFile(id string) string {
	return filepath.Join(s.listsDir, id+".json")
}

// ---------------------------------------------------------------- 配置

func (s *Store) LoadConfig() Config {
	cfg := defaultConfig()
	b, err := os.ReadFile(filepath.Join(s.dataDir, "config.json"))
	if err != nil {
		return cfg
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return defaultConfig()
	}
	if cfg.PageSize <= 0 {
		cfg.PageSize = 100
	}
	if cfg.Theme == "" {
		cfg.Theme = "dark"
	}
	return cfg
}

func (s *Store) SaveConfig(cfg Config) error {
	return writeJSON(filepath.Join(s.dataDir, "config.json"), cfg)
}

// ---------------------------------------------------------------- 列表读写

func newID() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}

// ListMetas 返回全部列表元信息（按更新时间倒序）
func (s *Store) ListMetas() ([]ListMeta, error) {
	entries, err := os.ReadDir(s.listsDir)
	if err != nil {
		return nil, err
	}
	out := make([]ListMeta, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		l, err := s.LoadList(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, l.ListMeta)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// LoadList 读取完整列表
func (s *Store) LoadList(id string) (*MD5List, error) {
	if id == "" || strings.ContainsAny(id, `/\`) {
		return nil, fmt.Errorf("非法的列表 ID")
	}
	b, err := os.ReadFile(s.listFile(id))
	if err != nil {
		return nil, err
	}
	var l MD5List
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, fmt.Errorf("列表文件损坏: %w", err)
	}
	if l.ID == "" {
		l.ID = id
	}
	l.FileName = id + ".json"
	l.refreshMeta()
	return &l, nil
}

// SaveList 写盘（原子替换）
func (s *Store) SaveList(l *MD5List) error {
	if l.ID == "" {
		l.ID = newID()
	}
	l.UpdatedAt = time.Now()
	if l.CreatedAt.IsZero() {
		l.CreatedAt = l.UpdatedAt
	}
	if l.Name == "" {
		l.Name = "未命名列表"
	}
	l.refreshMeta()
	l.FileName = l.ID + ".json"
	return writeJSON(s.listFile(l.ID), l)
}

func (s *Store) DeleteList(id string) error {
	if id == "" || strings.ContainsAny(id, `/\`) {
		return fmt.Errorf("非法的列表 ID")
	}
	return os.Remove(s.listFile(id))
}

// CopyList 另存为一份新列表
func (s *Store) CopyList(id, newName string) (*MD5List, error) {
	l, err := s.LoadList(id)
	if err != nil {
		return nil, err
	}
	l.ID = newID()
	if newName == "" {
		newName = l.Name + " 副本"
	}
	l.Name = newName
	l.CreatedAt = time.Now()
	l.UpdatedAt = time.Now()
	if err := s.SaveList(l); err != nil {
		return nil, err
	}
	return l, nil
}

func (s *Store) ImportList(path string) (*MD5List, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var l MD5List
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, fmt.Errorf("不是合法的列表文件: %w", err)
	}
	l.ID = newID()
	if l.Name == "" {
		l.Name = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	l.CreatedAt = time.Now()
	l.Dedupe() // 导入后立即去重，列表里不保留重复 MD5
	if err := s.SaveList(&l); err != nil {
		return nil, err
	}
	return &l, nil
}

// ExportList 导出为 json / csv / txt
func (s *Store) ExportList(id, format string, dest string) (string, error) {
	l, err := s.LoadList(id)
	if err != nil {
		return "", err
	}
	if dest == "" {
		ext := "." + format
		if format == "txt" {
			ext = ".txt"
		}
		dest = filepath.Join(s.dataDir, "export", sanitizeName(l.Name)+ext)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	switch format {
	case "csv":
		f, err := os.Create(dest)
		if err != nil {
			return "", err
		}
		defer f.Close()
		_, _ = f.WriteString("\xEF\xBB\xBF") // BOM，便于 Excel 打开
		w := csv.NewWriter(f)
		_ = w.Write([]string{"md5", "size", "paths", "count", "layers", "note"})
		for _, e := range l.Entries {
			ps := make([]string, 0, len(e.Paths))
			for _, p := range e.Paths {
				ps = append(ps, p.Path)
			}
			_ = w.Write([]string{e.MD5, strconv.FormatInt(e.Size, 10),
				strings.Join(ps, " | "), strconv.Itoa(len(e.Paths)),
				strings.Join(e.Layers, ","), e.Note})
		}
		w.Flush()
		return dest, w.Error()
	case "txt":
		f, err := os.Create(dest)
		if err != nil {
			return "", err
		}
		defer f.Close()
		for _, e := range l.Entries {
			for _, p := range e.Paths {
				fmt.Fprintf(f, "%s  %s\n", e.MD5, p.Path)
			}
		}
		return dest, nil
	default:
		return dest, writeJSON(dest, l)
	}
}

// ---------------------------------------------------------------- 回收站日志

func (s *Store) AppendTrashLog(items []TrashLogItem) error {
	if len(items) == 0 {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(s.dataDir, "trash-log.jsonl"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	for _, it := range items {
		if it.Time.IsZero() {
			it.Time = time.Now()
		}
		if err := enc.Encode(it); err != nil {
			return err
		}
	}
	return w.Flush()
}

func (s *Store) ReadTrashLog(limit int) ([]TrashLogItem, error) {
	f, err := os.Open(filepath.Join(s.dataDir, "trash-log.jsonl"))
	if err != nil {
		if os.IsNotExist(err) {
			return []TrashLogItem{}, nil
		}
		return nil, err
	}
	defer f.Close()
	var all []TrashLogItem
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		var it TrashLogItem
		if json.Unmarshal(sc.Bytes(), &it) == nil {
			all = append(all, it)
		}
	}
	// 只保留最近 limit 条
	if limit > 0 && len(all) > limit {
		all = all[len(all)-limit:]
	}
	// 倒序返回
	for i, j := 0, len(all)-1; i < j; i, j = i+1, j-1 {
		all[i], all[j] = all[j], all[i]
	}
	return all, nil
}

// ---------------------------------------------------------------- 列表运算

// refreshMeta 重算统计信息
func (l *MD5List) refreshMeta() {
	var total int64
	for _, e := range l.Entries {
		total += e.Size
	}
	l.Count = len(l.Entries)
	l.TotalSize = total
	if l.Layers == nil {
		l.Layers = []Layer{}
	}
}

// index 建立 md5 -> 条目下标
func (l *MD5List) index() map[string]int {
	m := make(map[string]int, len(l.Entries))
	for i, e := range l.Entries {
		m[e.MD5] = i
	}
	return m
}

// Dedupe 去重：合并相同 MD5 的条目，路径取并集
func (l *MD5List) Dedupe() (removed int, merged int) {
	seen := make(map[string]int, len(l.Entries))
	out := make([]Entry, 0, len(l.Entries))
	for _, e := range l.Entries {
		if idx, ok := seen[e.MD5]; ok {
			merged++
			out[idx].Paths = mergePaths(out[idx].Paths, e.Paths)
			out[idx].Layers = mergeStrings(out[idx].Layers, e.Layers)
			if out[idx].Note == "" {
				out[idx].Note = e.Note
			}
			if e.Size > out[idx].Size {
				out[idx].Size = e.Size
			}
			continue
		}
		seen[e.MD5] = len(out)
		if e.Paths == nil {
			e.Paths = []PathRef{}
		}
		if e.Layers == nil {
			e.Layers = []string{}
		}
		out = append(out, e)
	}
	removed = len(l.Entries) - len(out)
	l.Entries = out
	l.refreshMeta()
	return removed, merged
}

// MergeIn 把 src 的条目叠加进本列表
func (l *MD5List) MergeIn(src *MD5List, layer Layer) (added int, merged int) {
	idx := l.index()
	for _, e := range src.Entries {
		if i, ok := idx[e.MD5]; ok {
			before := len(l.Entries[i].Paths)
			l.Entries[i].Paths = mergePaths(l.Entries[i].Paths, e.Paths)
			if len(l.Entries[i].Paths) != before {
				merged++
			}
			l.Entries[i].Layers = mergeStrings(l.Entries[i].Layers, []string{layer.ID})
			if l.Entries[i].Note == "" {
				l.Entries[i].Note = e.Note
			}
			continue
		}
		ne := e
		ne.Layers = mergeStrings(ne.Layers, []string{layer.ID})
		if ne.Paths == nil {
			ne.Paths = []PathRef{}
		}
		l.Entries = append(l.Entries, ne)
		idx[e.MD5] = len(l.Entries) - 1
		added++
	}
	l.Layers = append(l.Layers, layer)
	l.refreshMeta()
	return added, merged
}

// AddLayer 记录一次来源批次
func (l *MD5List) AddLayer(layer Layer) {
	l.Layers = append(l.Layers, layer)
}

// RebuildLayersCount 重新统计每层条目数
func (l *MD5List) RebuildLayersCount() {
	cnt := map[string]int{}
	for _, e := range l.Entries {
		for _, id := range e.Layers {
			cnt[id]++
		}
	}
	for i := range l.Layers {
		if c, ok := cnt[l.Layers[i].ID]; ok {
			l.Layers[i].Count = c
		}
	}
}

// ---------------------------------------------------------------- 工具

func mergePaths(a, b []PathRef) []PathRef {
	seen := make(map[string]int, len(a)+len(b))
	for _, p := range a {
		seen[strings.ToLower(p.Path)] = 1
	}
	out := a
	for _, p := range b {
		k := strings.ToLower(p.Path)
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = 1
		out = append(out, p)
	}
	return out
}

func mergeStrings(a, b []string) []string {
	seen := make(map[string]bool, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, s := range append(append([]string{}, a...), b...) {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func writeJSON(path string, v interface{}) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func sanitizeName(s string) string {
	if s == "" {
		return "list"
	}
	bad := `<>:"/\|?*`
	for _, r := range bad {
		s = strings.ReplaceAll(s, string(r), "_")
	}
	s = strings.TrimSpace(s)
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}
