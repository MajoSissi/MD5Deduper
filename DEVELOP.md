# DEVELOP.md · 开发文档

面向维护者的文档。用户向说明见 [README.md](README.md)。

---

## 1. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 外壳 | [Wails v2](https://wails.io) v2.16 | 把 Go 后端 + 静态前端打包成单个 exe |
| 后端 | Go 1.25+ | 纯 Go 编译，Windows 上 **不需要 cgo**（不需要 gcc / MSVC） |
| 前端 | 原生 HTML / CSS / JS | **没有构建步骤**：无 Vite / npm / ES module，`index.html` 按顺序加载普通 `<script>` |
| 设计系统 | 手写 Material Design 3 | `frontend/src/md3.css`，主题固定深色 |

前端之所以不用框架和打包器，是为了让「改一行 JS 就生效」这件事成立，也让产物里只有 Go 一个编译环节。
代价是必须手工维护全局命名空间与加载顺序。

---

## 2. 环境要求

- **Go 1.25+**（CI 与本地常用 1.27.1）
- **Wails CLI**：`go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`
- **Node**（可选）：只用来跑 `node --check` 做语法检查，不参与构建
- **Python**（可选）：本地预览脚本与截图辅助
- 运行 exe 需要 **WebView2 Runtime**（Win11 自带）

Windows 上无需安装 MinGW / MSVC，`CGO_ENABLED=0` 即可。

---

## 3. 目录结构

```
.
├── main.go                  # 入口：窗口配置、无边框、拖放、关闭拦截
├── app.go                   # App 绑定对象：所有导出给前端的方法
├── types.go                 # 前后端共用的数据结构（JSON tag 即前端字段名）
├── store.go                 # 持久化：data 目录、config、lists、导出、回收站日志
├── scan.go                  # 扫描引擎：遍历 → 增量复用 → 并发算 MD5 → 分组
├── check.go                 # 查重引擎：对待查对象算 MD5 并与基准列表比对
├── platform_windows.go      # Windows 专用：资源管理器定位、回收站
├── platform_other.go        # 其他平台的空实现（保证跨平台可编译）
├── engine_test.go           # 扫描 / 查重 / 列表的核心逻辑测试
├── wails.json               # Wails 项目配置
├── build/                   # 图标、Windows 资源、安装器脚本、构建产物 build/bin/
├── frontend/
│   ├── index.html           # 按顺序加载所有脚本（顺序不能乱）
│   └── src/
│       ├── md3.css          # 设计系统（CSS 变量 + 组件样式）
│       ├── icons.js         # ICO(name,size) / LOGO(size) 图标
│       ├── ui.js            # UI：格式化、对话框、自绘菜单、提示
│       ├── widgets.js       # W：复合控件（统计卡、分页、下拉、搜索框）
│       ├── api.js           # API：后端桥 + 事件总线 Bus + State
│       ├── pages/scan.js    # 页面：目录扫描
│       ├── pages/check.js   # 页面：文件查重
│       ├── pages/lists.js   # 页面：列表管理
│       ├── pages/settings.js# 页面：设置
│       └── app.js           # Shell：导航、顶栏、底部功能区、路由、拖放
├── dev-preview.html         # 浏览器端假后端预览（不参与打包）
└── screenshots/             # 界面截图（开发用）
```

---

## 4. 构建与运行

```bash
# 开发模式：热重载，改动前端立刻生效
wails dev

# 生产构建
wails build -clean                 # → build/bin/MD5Deduper.exe
wails build -clean -trimpath -nsis # 顺带产出 NSIS 安装包
```

### 版本号注入

`app.go` 里的版本号刻意声明为 **变量** 而非常量：

```go
var appVersion = "1.0.0"
```

这样构建时可以注入：

```bash
wails build -clean -ldflags "-s -w -X main.appVersion=1.2.3"
```

CI 的手动构建流程就是这么干的（见第 9 节）。

### 生成 Wails 绑定

**新增 / 修改 / 删除后端导出方法后**，必须刷新绑定，否则前端 `call('Xxx')` 会找不到方法：

```bash
wails generate module   # 或直接 wails build（构建过程也会重新生成）
```

生成的 `frontend/wailsjs/go/main/App.d.ts` 是校验方法名是否对得上的最好依据。

---

## 5. 后端架构

### 5.1 生命周期

`main.go` 里注册了四个钩子：

| 钩子 | 作用 |
| --- | --- |
| `OnStartup` | 初始化 `Store`、载入配置，然后 `EventsEmit("app:ready", env)` 通知前端 |
| `OnShutdown` | 取消所有仍在运行的 job |
| `OnBeforeClose` | **有关闭拦截**：有任务在跑且用户尚未确认退出时，`EventsEmit("app:beforeClose")` 并返回 `true` 阻止关闭 |

关闭拦截有个容易踩的坑：Wails 的 `runtime.Quit()` **同样**会触发 `OnBeforeClose`。
所以用户在前端确认退出后，必须走 `App.ForceQuit()`（先把 `forceQuit` 置真，再 `Quit`），
否则会陷入「确认 → 又被拦 → 再弹框」的死循环。

### 5.2 App（`app.go`）

`App` 是唯一绑定给前端的对象，所有 `func (a *App) Xxx(...)` 导出方法都会生成对应的 JS 桥接。
它持有：

- `store *Store`：持久化
- `cfg Config`：当前配置
- `jobs map[string]context.CancelFunc`：正在运行的任务，`len(jobs) > 0` 即「有任务在跑」
- `scans / checks`：任务结果会话，结果**留在内存**，前端按 `jobId` 分页拉取
- `lcache`：列表读缓存（按文件 mtime 失效）

### 5.3 Store（`store.go`）

负责 `data` 目录下的一切。目录优先取 **exe 所在目录**，不可写时退回当前工作目录：

```
data/
├── config.json
├── lists/<id>.json
├── export/
└── trash-log.jsonl
```

### 5.4 扫描引擎（`scan.go`）

流程：`scanRoots()` 归一化去重 → `walker` 遍历（支持目录与单文件根）→ 增量复用（mtime+size 未变则复用上次 MD5）
→ 并发计算 MD5 → 按 MD5 分组 → 统计。

- 多根扫描结果**合并为同一份**，跨目录的相同文件会落进同一个重复组。
- 增量缓存让「同一目录第二次扫描」几乎瞬时完成，结果里的「增量复用」即跳过数。

### 5.5 查重引擎（`check.go`）

只对待查对象计算 MD5，然后与基准列表的 MD5 集合求交集，产出 `CheckItem` 列表（含命中路径与来源列表）。

### 5.6 任务与事件

长任务跑在 goroutine 里，通过事件推进度，结束时把结果留在内存：

| 事件 | 时机 | 载荷 |
| --- | --- | --- |
| `app:ready` | 后端初始化完成 | `EnvInfo` |
| `job:progress` | 扫描 / 查重过程中 | `JobProgress`（phase / total / done / bytes / speed…） |
| `job:done` | 任务结束 | `{jobId, kind, ok, error, scan?, check?}` |
| `app:beforeClose` | 有任务时用户尝试关闭窗口 | 无 |

前端在 `api.js` 里用 `Bus` 订阅这四个事件。

### 5.7 自动去重

需求上「去重应当是自动的」，因此 `MD5List.Dedupe()` 被内嵌进所有会产生列表的路径：

| 路径 | 位置 |
| --- | --- |
| 扫描后新建列表 | `app.go` → `archiveScan()` 新建分支 |
| 扫描后叠加 | `app.go` → `archiveScan()` 叠加分支 |
| 列表叠加列表 | `app.go` → `MergeLists()` |
| 导入列表 | `store.go` → `ImportList()` |
| 查重结果存档 | `app.go` → `ArchiveCheck()` |

所以后端**没有** `DedupeList` / `NewList` 这两个绑定方法，前端也没有对应入口。

### 5.8 后端 API 一览

前端通过 `frontend/src/api.js` 的 `API.xxx` 调用，方法名与 `App.d.ts` 一致。

| 分组 | 方法 |
| --- | --- |
| 环境 / 配置 | `GetEnv` `GetConfig` `SetConfig` `OpenDataDir` `RevealPath` `ForceQuit` |
| 对话框 | `PickDirectory` `PickFiles` `PickOpenPath` `PickSavePath` `InspectPaths` |
| 扫描 | `StartScan` `ScanPage` `ScanGroups` `CancelJob` `LastJob` |
| 查重 | `StartCheck` `CheckPage` `CheckAllMatched` `ArchiveCheck` `MoveToTrash` |
| 列表 | `ListMetas` `GetListMeta` `ListPage` `RenameList` `DeleteList` `CopyList` `MergeLists` `ExportList` `ImportList` |
| 其他 | `TrashLog` |

`InspectPaths` 很关键：前端把拖入 / 输入的路径交给它，由后端判断每个路径是**目录还是文件**，
前端据此显示不同图标并决定扫描语义。

`ArchiveCheck` 的 `CheckArchiveRequest` 用 `scope` 选择存档内容：
`unique`（未命中，**默认**）/ `matched`（仅重复）/ `all`（全部）；留空时按旧字段 `OnlyMatched` 兼容推断，
都没有则取 `unique`。层名留空时会自动带上范围，如 `查重结果·未命中 10-15 19:40`。

---

## 6. 前端架构

### 6.1 全局命名空间

没有模块系统，所有东西挂在 `window` 上：

| 名字 | 职责 |
| --- | --- |
| `ICO(name, size)` | 内联 SVG 图标 |
| `LOGO(size)` | 程序 Logo（`frontend/src/appicon.png` 的副本） |
| `UI` | 格式化（`num/bytes/duration/fmtTime/relTime`）、`esc`、对话框、自绘菜单、`toast`、`copyText` |
| `W` | 复合控件：`statGrid` `pagerHtml/bindPager` `pathCell` `searchBox/bindSearch` `selectHtml/bindSelects/selValue` |
| `API` | 后端桥（`call('Xxx', ...)` 的薄封装） |
| `Bus` | 事件总线：`Bus.on('progress'\|'done'\|'ready'\|'beforeClose', fn)` |
| `State` | 全局状态：`env` `config` `lists` `scan` `check` `listsPage` … |
| `Shell` | 外壳：`go` `reloadLists` `applyConfig` `refreshActions` `showTrashLog` `current` |
| `Pages` | 页面注册表：`Pages.scan` / `Pages.check` / `Pages.lists` / `Pages.settings` |

### 6.2 页面接口契约

每个页面是一个 IIFE，最后把自己注册到 `window.Pages`：

```js
window.Pages.scan = {
  id: 'scan', title: '目录扫描', subtitle: '…', icon: 'scan',
  mount(root) {},            // 渲染页面，root 是 #pageRoot
  unmount() {},              // 清理（如移除 page-lists 类）
  actions() { return []; },   // 底部功能区按钮
  status() { return ''; },    // 底部功能区左侧状态（HTML 字符串）
  onProgress(p) {},           // 收到 job:progress
  onDone(d) {},               // 收到 job:done
  onDrop(paths) {},           // 拖入文件 / 目录
  dropHint() { return ''; },  // 拖放时的提示文案
  isRunning() { return false; },
  select(id) {},              // 可选：Shell.go(id, arg) 跳转时带上参数
  refresh() {},               // 可选：外部要求刷新
  reset() {},                 // 可选：清空本页状态（当前由页面内部调用，Shell 未统一调用）
};
```

### 6.3 底部功能区（`.actionbar`）

所有页面的主要按钮都放在窗口底部，由 `app.js` 的 `refreshActions()` 渲染 `Pages[currentId].actions()` 的**全部**返回项：

```js
{ id: 'start', label: '开始扫描', icon: 'play', variant: 'filled', disabled: false,
  title: '可选 tooltip', onClick: fn }
{ divider: true }   // 渲染成竖分隔线 .ab-sep
```

约定：

- 按钮行 `nowrap`，按钮 `flex: 0 0 auto`，输入框给可收缩的 `min-width`，否则窄窗口会把按钮挤没。
- `status()` 返回 HTML 字符串，建议 `ICO('xxx', 14) + '<span class="ab-text">…</span>'`。
- **没有二级菜单**：`menuItems()`、顶栏「更多」按钮、`overflowMenu()` 都已删除。新增功能请放进底部功能区或页面卡片内。

### 6.4 设计系统（`md3.css`）

- 主题**固定深色**（`applyTheme()` 恒写 `data-theme="dark"`，界面无主题设置项；`[data-theme="light"]` 仅保留供 `dev-preview.html?auto=light` 使用）。
- 尺寸基准（改动前先看这些变量，别到处写魔法数）：

  | 变量 / 类 | 值 |
  | --- | --- |
  | `--field-h` / `--field-fs` | `40px` / `13px` |
  | `.btn` / `.btn--sm` | `34px` / `28px` |
  | `.icon-btn` / `.icon-btn--sm` | `34px` / `28px` |
  | `.menu-item` | `40px` |
  | `.chip` / `.search` / `.appbar` | `28px` / `32px` / `56px` |
  | `--rail-w` | `84px` |

- **下拉框一律用 `W.selectHtml` / `setSelectOptions` / `bindSelects` / `selValue`**，不要用原生 `<select>`
  （原生弹层无法跟随深色主题）。
- 列表页是**整页定高**的特例：`.view-inner.page-lists{height:100%;min-height:0}` + `.page-lists .split{align-items:stretch}`
  + `#listItems{flex:1;overflow:auto}`；`Pages.lists.mount` 给 `#pageRoot` 加 `page-lists` 类，`unmount` 移除。

### 6.5 无边框窗口

`main.go` 设 `Frameless: true`，标题栏由前端自绘：

- 顶栏 `.appbar` 用 CSS 变量 `--wails-draggable: drag` 实现拖动，按钮要 `no-drag`；
- 窗口按钮调用 `runtime.WindowMinimise` / `WindowToggleMaximise` / `runtime.Quit`；
- 三个窗口按钮固定在顶栏最右侧（`.win-controls { margin-left: auto }`）。

### 6.6 文件拖放

1. `main.go` 配 `DragAndDrop{EnableFileDrop: true}`；
2. `#app` 设 `--wails-drop-target: drop`；
3. `runtime.OnFileDrop(cb, true)` 拿到**绝对路径**；
4. 路径交给 `API.inspectPaths()` 判定类型，再决定按目录还是按文件加入。

---

## 7. 新增一个页面的步骤

1. 在 `frontend/src/pages/` 新建 `xxx.js`，按第 6.2 节实现页面对象并注册到 `window.Pages.xxx`；
2. 在 `frontend/index.html` 中**按依赖顺序**加 `<script src="./src/pages/xxx.js"></script>`（放在 `app.js` 之前）；
3. 在 `app.js` 的导航项列表里加一条（图标 + 标题）；
4. 如果页面需要新的后端方法：在 `app.go` 加导出方法 → `wails generate module` → 在 `api.js` 加一行桥接；
5. 在 `dev-preview.html` 的假后端里补上该方法，并加一个 `?auto=` 场景方便回归。

---

## 8. 调试与验证

### 8.1 为什么不用 `wails dev` 看效果

本项目开发环境**无法启动带 WebView2 的 GUI 程序**（进程会被直接终止），
因此界面验证走「假后端 + 无头浏览器」这条路。

### 8.2 `dev-preview.html`

这是一个**不参与打包**的浏览器预览页，内置一个假后端（所有 `API.*` 返回 mock 数据），
可以直接在浏览器里打开调试界面与交互：

```bash
python -m http.server 8099 --bind 127.0.0.1
# 然后访问 http://127.0.0.1:8099/dev-preview.html#scan
```

页面 hash 决定初始路由（`#scan` `#check` `#lists` `#settings`），
`?auto=<场景>` 会自动摆出一个可复现的状态：

| 场景 | 用途 |
| --- | --- |
| `scan` `multiscan` `dropscan` `groupdlg` | 扫描页的各种目标状态与结果 |
| `check` `check-sel` `archivedlg` `drop` | 查重页待查 / 选中 / 存档对话框 |
| `lists` `lists-sel` `mergedlg` `exportdlg` `dlgselect` | 列表页详情、`lists-sel` 为 Ctrl 多选高亮态 |
| `lists-ctx` `lists-ctx2` | 右键菜单定位：`lists-ctx` 右键未选中项，`lists-ctx2` 已多选后右键；均输出 `CTX {pointer,item,menu,…}` 探针，菜单矩形应贴着光标 |
| `lists-del` | 删除后的状态一致性：焦点在第 2 项、右键删第 1 项；加 `&del=active` 改为删掉焦点项本身。输出 `DEL1/DEL2 {items,active,selected,detail}` 探针（`DEL1` 删除刚完成、`DEL2` 再点一次剩下那项之后） |
| `settings` `trashlog` `light` `overlay` `select` `closeconfirm` | 设置、回收站日志、浅色、遮罩、下拉、关闭确认 |
| `none` | 什么都不做，只为在任意页面拿到**完整**几何探针（`?auto=none&geo=1#scan`） |

> `check` 系场景 hash 必须用 `#check`，`lists` 系用 `#lists`，否则页面没 mount 会报 null。

### 8.3 几何探针 `?geo=1`

加 `?geo=1` 后页面会把关键元素的位置尺寸写进 `#__geo`，可以用 `--dump-dom` 读出来做量化断言：

```bash
chrome --headless=new --disable-gpu --no-proxy-server \
  --window-size=1440,900 --virtual-time-budget=6000 --dump-dom \
  "http://127.0.0.1:8099/dev-preview.html?geo=1#lists" | grep -o 'GEO {.*}'
```

覆盖 `inner / docScroll / actionbar / abActions / abStatus / split / listItems / listDetail / table / pager / winControls`，
以及扫描 / 查重页的 `firstCard / scanAdd / scanRoots / chkLists / chkAdd / chkTargets / hidden / cardBottom`。
布局类改动（对齐、溢出、贴边、空洞）用这个验证比肉眼看截图可靠。

> 不带 `?auto=` 时探针只输出基础字段（`page / winControls / actionbar / firstBtn`）。
> 要拿完整字段必须带 `?auto=`，用一个不匹配任何场景的值即可（`?auto=none`）。

> **查询参数必须写在 `#hash` 之前**：`?auto=lists&geo=1#lists` 有效，
> 写成 `?auto=lists#lists&geo=1` 时 `geo` 属于 fragment，`URLSearchParams` 读不到，探针不会输出。

`lists-ctx` / `lists-ctx2` 场景另写一份 `#__ctx` 探针（`CTX {pointer,item,menu,selected,labels}`），
专测右键菜单定位：菜单矩形应贴着 `pointer`（旧 bug 是重绘后锚点元素失效，菜单被 clamp 到左上角 `[8,6]`）。

### 8.4 截图

```bash
chrome --headless=new --disable-gpu --no-proxy-server \
  --window-size=1440,900 --virtual-time-budget=6000 \
  --screenshot=screenshots/xx.png \
  "http://127.0.0.1:8099/dev-preview.html?auto=dropscan#scan"
```

注意事项：

- 必须加 `--no-proxy-server`，否则可能走系统代理导致 `ERR_CONNECTION_REFUSED`；
- 文件名含中文时用 Python `subprocess` 传参，bash 下 `--screenshot=screenshots/中文.png` 会静默不落盘；
- 一次别超过 4 张，否则整个命令可能超时被杀；
- 静态服务用后台常驻方式启动，用完再停。

### 8.5 运行时错误检查

`dev-preview.html` 会把 JS 运行时错误累计显示在错误条里，可以用它做回归：

```bash
for pair in "scan:scan" "check-sel:check" "lists:lists" "settings:settings"; do
  s=${pair%%:*}; h=${pair##*:}
  chrome --headless=new --disable-gpu --no-proxy-server --window-size=1440,900 \
    --virtual-time-budget=7000 --dump-dom \
    "http://127.0.0.1:8099/dev-preview.html?auto=$s#$h" 2>/dev/null |
    grep -qE 'JS 错误 x[0-9]+' && echo "[$s] ERR" || echo "[$s] ok"
done
```

---

## 9. CI：手动构建

`.github/workflows/manual-build.yml`，**仅 `workflow_dispatch` 触发**（不随 push 自动跑）。

参数：

| 输入 | 默认 | 说明 |
| --- | --- | --- |
| `version` | `1.0.0` | 注入 `main.appVersion`，并用于产物命名 |
| `go-version` | `1.27.1` | 构建用 Go 版本 |
| `wails-version` | `v2.16.0` | Wails CLI 版本 |
| `make-installer` | `false` | 是否额外产出 NSIS 安装包 |
| `create-release` | `false` | 是否创建 / 更新 GitHub Release 并上传产物 |

流程：checkout → setup-go（带模块缓存）→ `go install` Wails CLI → `gofmt -l` 门禁 → `go vet` + `go test`
→ `wails build -clean -trimpath`（`CGO_ENABLED=0`）→ 上传 Artifact →（可选）打 Release。

命令行触发：

```bash
gh workflow run manual-build.yml -f version=1.0.1 -f make-installer=true -f create-release=true
```

---

## 10. 交付前检查清单

```bash
# 1. 前端语法（每个脚本都要过）
for f in frontend/src/*.js frontend/src/pages/*.js; do node --check "$f" || echo "FAIL $f"; done

# 2. Go 格式化 / 静态检查 / 测试
gofmt -l .
go vet ./...
go test ./...

# 3. 构建
wails build -clean

# 4. 浏览器回归：dev-preview.html 各场景无 JS 错误（见 8.5）

# 5. 核对前端 call('X') 与 App.d.ts 的导出名一致
```

另外两个易错点：

- 在项目根目录直接跑 `go build ./...` 会在根目录生成一个 `MD5Deduper.exe`，记得删掉，别提交进去。
- 新增后端方法后忘了 `wails generate module`，前端会报「方法不存在」。

---

## 11. 已知约定与坑

- **无二级菜单**：顶栏只有 Logo 与窗口按钮；不要重新引入「更多」菜单。
- **主题固定深色**：不要读 `State.config.theme` 去切主题。
- **扫描 / 查重参数写死**：`minSize: 0`、`exclude: []`、`skipHidden: true`、`recursive: true`，
  扫描另有 `incremental: true`、`archive: true`。后端 `Config` 仍保留这些字段，但前端不再读写。
- **列表不记来源路径**：`ListMeta` 没有 `Sources` 字段，条目只保留 `MD5 / 大小 / 文件名`。
- **自动去重**：新增任何「产生列表」的入口，都要记得在里面调用 `Dedupe()`。
- **关闭拦截**：确认退出必须走 `App.ForceQuit()`，否则会被 `OnBeforeClose` 反复拦截。
- **程序图标**：`build/appicon.png` → `build/windows/icon.ico` 是 exe 图标；
  界面左上角 `.rail-logo` 用的是它的副本 `frontend/src/appicon.png`。换图标要**同时替换两处**并重新构建。
- **换行符必须是 LF**：`gofmt` 会把 CRLF 文件判定为「未格式化」，而 Git for Windows 默认 `core.autocrlf=true`，
  克隆 / 检出时会把 LF 换成 CRLF —— 结果是 CI 的 `gofmt -l` 门禁把**所有** `.go` 文件都报出来（本地却干净）。
  仓库根的 `.gitattributes`（`* text=auto eol=lf`）已固定这一点，CI 的检查步骤也先归一化换行符兜底。
  **如果哪天 `gofmt -l` 突然列出全部文件，先查换行符，不要真的去 `gofmt -w`。**
- **「在资源管理器中定位」不要走命令行**：`exec.Command("explorer", "/select,"+abs)` 在路径含空格 / 中文时，
  Go 会把整个 `/select,C:\My Docs\a.jpg` 参数用引号包起来，explorer 解析失败后**退而打开「文档」库**
  （现象就是「定位都跳到文档路径」）。`platform_windows.go` 的 `revealInExplorer` 改用 Shell API
  `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`（纯 syscall，无需 cgo），命令行的写法只作为兜底。
  文件不存在时退而打开所在目录；前端调用 `API.reveal` 都要 `.catch` 出提示。
- **`UI.showMenu` 的锚点不能用会被重绘销毁的元素**：列表 / 表格整表 `innerHTML` 重写后，
  先前传进去的元素 `getBoundingClientRect()` 全 0，菜单会被 clamp 到左上角 `[8,6]`。
  右键菜单一律传指针坐标 `{x: e.clientX, y: e.clientY}`；`ui.js` 的 `anchorRect()` 会对失效锚点兜底到 `lastPointer`。
- **重绘要保住滚动位置**：`#listItems` 这类 `overflow:auto` 容器被 `innerHTML` 重写后 `scrollTop` 会归零，
  重绘前后要手动保存 / 恢复；一次交互里的多步状态更新合并成**一次**渲染，别连着调两遍。
