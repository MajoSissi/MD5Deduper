//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// recycleFiles 非 Windows 平台暂不支持回收站
func recycleFiles(paths []string) (int, []string) {
	return 0, []string{"当前平台暂不支持移入回收站"}
}

func isHiddenInfo(fi os.FileInfo) bool { return false }

func revealInExplorer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", abs).Start()
	}
	return exec.Command("xdg-open", filepath.Dir(abs)).Start()
}

func toAbsWindowsPath(p string) (string, error) {
	return filepath.Abs(p)
}
