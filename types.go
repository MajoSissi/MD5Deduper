package main

import "time"

// ---------------------------------------------------------------- 基础信息

// EnvInfo 运行环境信息
type EnvInfo struct {
	DataDir string `json:"dataDir"`
	ExeDir  string `json:"exeDir"`
	Version string `json:"version"`
	OS      string `json:"os"`
	NumCPU  int    `json:"numCPU"`
}

// Config 应用配置，落盘 data/config.json
type Config struct {
	Theme       string   `json:"theme"` // light | dark | system
	Concurrency int      `json:"concurrency"`
	MinSize     int64    `json:"minSize"`
	Exclude     []string `json:"exclude"`
	SkipHidden  bool     `json:"skipHidden"`
	Recursive   bool     `json:"recursive"`
	Incremental bool     `json:"incremental"`
	PageSize    int      `json:"pageSize"`
	LastScanDir string   `json:"lastScanDir"`
	LastCheckIn []string `json:"lastCheckIn"`
}

func defaultConfig() Config {
	return Config{
		Theme:       "dark",
		Concurrency: 0, // 0 = 自动
		MinSize:     0,
		Exclude:     []string{},
		SkipHidden:  true,
		Recursive:   true,
		Incremental: true,
		PageSize:    100,
	}
}

// ---------------------------------------------------------------- MD5 列表

// PathRef 一条路径记录（同一 MD5 可能有多个物理文件）
type PathRef struct {
	Path  string `json:"path"`
	MTime int64  `json:"mtime"`
}

// Entry 一条 MD5 记录
type Entry struct {
	MD5    string    `json:"md5"`
	Size   int64     `json:"size"`
	Paths  []PathRef `json:"paths"`
	Note   string    `json:"note,omitempty"`
	Layers []string  `json:"layers,omitempty"`
}

// Primary 返回首条路径
func (e Entry) Primary() string {
	if len(e.Paths) == 0 {
		return ""
	}
	return e.Paths[0].Path
}

// Layer 叠加层：记录列表是由哪些批次叠加而成的
type Layer struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Note    string    `json:"note,omitempty"`
	Source  string    `json:"source,omitempty"`
	AddedAt time.Time `json:"addedAt"`
	Count   int       `json:"count"`
	Added   int       `json:"added"`  // 新增条目数
	Merged  int       `json:"merged"` // 与已有条目合并的条数
}

// ListMeta 列表元信息
type ListMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Note      string    `json:"note,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Count     int       `json:"count"`
	TotalSize int64     `json:"totalSize"`
	Layers    []Layer   `json:"layers,omitempty"`
	FileName  string    `json:"fileName"`
}

// MD5List 完整列表（含条目）
type MD5List struct {
	ListMeta
	Entries []Entry `json:"entries"`
}

// ---------------------------------------------------------------- 扫描

// ScanOptions 扫描选项
type ScanOptions struct {
	MinSize    int64    `json:"minSize"`
	Exclude    []string `json:"exclude"`
	SkipHidden bool     `json:"skipHidden"`
}

// ScanRequest 扫描请求
type ScanRequest struct {
	Root        string      `json:"root"`  // 单个根目录（保留兼容；Roots 为空时才使用）
	Roots       []string    `json:"roots"` // 多个根目录：结果合并为同一份
	Options     ScanOptions `json:"options"`
	Incremental bool        `json:"incremental"`
	Archive     bool        `json:"archive"`
	SaveAs      string      `json:"saveAs"`
	Note        string      `json:"note"`
	BaseListID  string      `json:"baseListId"` // 非空则叠加到该列表
}

// DupGroup 重复组：同一 MD5 的多个文件
type DupGroup struct {
	MD5   string    `json:"md5"`
	Size  int64     `json:"size"`
	Count int       `json:"count"`
	Paths []PathRef `json:"paths"`
	Waste int64     `json:"waste"`
}

// ScanResult 扫描结果
type ScanResult struct {
	JobID     string     `json:"jobId"`
	OK        bool       `json:"ok"`
	Error     string     `json:"error,omitempty"`
	Root      string     `json:"root"`
	Roots     []string   `json:"roots,omitempty"` // 本次扫描的根目录（可能多个）
	Files     int        `json:"files"`
	Unique    int        `json:"unique"`
	Groups    int        `json:"groups"`
	DupFiles  int        `json:"dupFiles"`
	Waste     int64      `json:"waste"`
	TotalSize int64      `json:"totalSize"`
	Errors    int        `json:"errors"`
	Skipped   int        `json:"skipped"`
	ElapsedMs int64      `json:"elapsedMs"`
	ListID    string     `json:"listId,omitempty"`
	ListName  string     `json:"listName,omitempty"`
	GroupsTop []DupGroup `json:"groupsTop,omitempty"`
}

// ---------------------------------------------------------------- 查重

// CheckRequest 查重请求
type CheckRequest struct {
	ListIDs    []string `json:"listIds"`
	Targets    []string `json:"targets"`
	Recursive  bool     `json:"recursive"`
	MinSize    int64    `json:"minSize"`
	Exclude    []string `json:"exclude"`
	SkipHidden bool     `json:"skipHidden"`
}

// CheckItem 单个文件的查重结果
type CheckItem struct {
	Path      string `json:"path"`
	MD5       string `json:"md5"`
	Size      int64  `json:"size"`
	Matched   bool   `json:"matched"`
	MatchPath string `json:"matchPath,omitempty"`
	MatchList string `json:"matchList,omitempty"`
	Error     string `json:"error,omitempty"`
}

// CheckArchiveRequest 把查重结果存档为 MD5 列表（新建或叠加）
type CheckArchiveRequest struct {
	JobID       string `json:"jobId"`
	TargetID    string `json:"targetId"` // 非空则叠加到该列表，否则新建
	SaveAs      string `json:"saveAs"`   // 新建 / 层名称
	Note        string `json:"note"`
	OnlyMatched bool   `json:"onlyMatched"` // true = 只存档命中重复的文件
}

// CheckResult 查重结果
type CheckResult struct {
	JobID     string   `json:"jobId"`
	OK        bool     `json:"ok"`
	Error     string   `json:"error,omitempty"`
	Total     int      `json:"total"`
	Matched   int      `json:"matched"`
	Unique    int      `json:"unique"`
	MatchSize int64    `json:"matchSize"`
	Errors    int      `json:"errors"`
	ElapsedMs int64    `json:"elapsedMs"`
	Lists     []string `json:"lists,omitempty"`
}

// ---------------------------------------------------------------- 任务进度

// JobProgress 任务进度（通过事件推送到前端）
type JobProgress struct {
	JobID     string `json:"jobId"`
	Kind      string `json:"kind"`  // scan | check
	Phase     string `json:"phase"` // walking | hashing | done
	Total     int    `json:"total"`
	Done      int    `json:"done"`
	Skipped   int    `json:"skipped"`
	Errors    int    `json:"errors"`
	Bytes     int64  `json:"bytes"`
	Current   string `json:"current"`
	ElapsedMs int64  `json:"elapsedMs"`
	Speed     int64  `json:"speed"` // bytes/s
}

// ---------------------------------------------------------------- 回收站

// TrashResult 移入回收站结果
type TrashResult struct {
	Moved  int      `json:"moved"`
	Failed int      `json:"failed"`
	Freed  int64    `json:"freed"`
	Errors []string `json:"errors"`
	DryRun bool     `json:"dryRun"`
}

// ---------------------------------------------------------------- 通用

// PageQuery 分页查询
type PageQuery struct {
	Key    string `json:"key"` // 列表 ID / 任务 ID
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
	Query  string `json:"query"`
	Filter string `json:"filter"` // all | dup | unique
	Layer  string `json:"layer"`
	Sort   string `json:"sort"` // path | size | md5
	Desc   bool   `json:"desc"`
}

// Page 分页结果
type Page struct {
	Total  int         `json:"total"`
	Offset int         `json:"offset"`
	Limit  int         `json:"limit"`
	Items  interface{} `json:"items"`
}

// OpResult 通用操作结果
type OpResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
	Count   int    `json:"count,omitempty"`
	Added   int    `json:"added,omitempty"`
	Merged  int    `json:"merged,omitempty"`
	ListID  string `json:"listId,omitempty"`
}

// MergeRequest 叠加请求
type MergeRequest struct {
	TargetID  string `json:"targetId"`
	SourceID  string `json:"sourceId"`
	LayerName string `json:"layerName"`
	Note      string `json:"note"`
}

// TrashLogItem 回收站日志条目
type TrashLogItem struct {
	Time   time.Time `json:"time"`
	Path   string    `json:"path"`
	MD5    string    `json:"md5,omitempty"`
	Size   int64     `json:"size,omitempty"`
	Source string    `json:"source,omitempty"`
}
