package main

import (
	"context"
	"embed"
	"io/fs"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	app := NewApp()

	sub, err := fs.Sub(assets, "frontend")
	if err != nil {
		panic(err)
	}

	err = wails.Run(&options.App{
		Title:     "MD5 查重去重工具",
		Width:     1320,
		Height:    860,
		MinWidth:  1060,
		MinHeight: 680,
		// 无系统边框：标题栏由前端自绘（左侧导航直通到顶 + 顶栏窗口按钮）
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: sub,
		},
		BackgroundColour: &options.RGBA{R: 17, G: 19, B: 24, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		// 有任务在跑时，原生关闭（Alt+F4 / 系统菜单 / 前端 Quit）先拦下来，由前端弹确认框；
		// 用户确认后走 App.ForceQuit()，此时 allowClose() 为真，不再拦截。
		OnBeforeClose: func(ctx context.Context) (prevent bool) {
			if app.allowClose() || !app.hasRunningJob() {
				return false
			}
			wailsruntime.EventsEmit(ctx, "app:beforeClose", nil)
			return true
		},
		Bind: []interface{}{
			app,
		},
		// 允许把文件 / 目录拖进窗口，由前端 OnFileDrop 接收绝对路径
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
