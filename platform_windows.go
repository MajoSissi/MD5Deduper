//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modShell32           = windows.NewLazySystemDLL("shell32.dll")
	procSHFileOperationW = modShell32.NewProc("SHFileOperationW")
	// 打开「文件所在目录并选中该文件」的 Shell API（不走命令行）
	procSHOpenFolderAndSelectItems = modShell32.NewProc("SHOpenFolderAndSelectItems")
	procILCreateFromPathW          = modShell32.NewProc("ILCreateFromPathW")
)

const (
	foDelete          = 0x0003
	fofSilent         = 0x0004
	fofNoConfirmation = 0x0010
	fofAllowUndo      = 0x0040
	fofNoErrorUI      = 0x0400
)

// shFileOpStructW 与 Win32 SHFILEOPSTRUCTW 内存布局一致（amd64 自然对齐 56 字节）
type shFileOpStructW struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

const trashBatch = 64

// recycleFiles 把文件移入 Windows 回收站（可撤销）
func recycleFiles(paths []string) (int, []string) {
	var errs []string
	moved := 0
	batch := make([]string, 0, trashBatch)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		cnt := len(batch)
		var buf []uint16
		for _, p := range batch {
			u, err := syscall.UTF16FromString(p)
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: 路径非法", p))
				cnt--
				continue
			}
			buf = append(buf, u[:len(u)-1]...)
			buf = append(buf, 0)
		}
		batch = batch[:0]
		if len(buf) == 0 {
			return
		}
		buf = append(buf, 0) // 双 NUL 结尾

		op := shFileOpStructW{
			wFunc:  foDelete,
			pFrom:  &buf[0],
			fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
		}
		ret, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
		if ret != 0 {
			errs = append(errs, fmt.Sprintf("Shell 删除失败 (code %d)，路径可能过长或文件被占用", ret))
		} else if op.fAnyOperationsAborted != 0 {
			errs = append(errs, "操作被中止")
		} else {
			moved += cnt
		}
	}

	for _, p := range paths {
		abs, err := toAbsWindowsPath(p)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", p, err))
			continue
		}
		if len(abs) >= 259 {
			errs = append(errs, fmt.Sprintf("%s: 路径超过 260 字符，无法移入回收站", abs))
			continue
		}
		if _, err := os.Stat(abs); err != nil {
			errs = append(errs, fmt.Sprintf("%s: 文件不存在或不可访问", abs))
			continue
		}
		batch = append(batch, abs)
		if len(batch) >= trashBatch {
			flush()
		}
	}
	flush()
	return moved, errs
}

func toAbsWindowsPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("空路径")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	abs = strings.ReplaceAll(abs, "/", `\`)
	abs = strings.TrimPrefix(abs, `\\?\`)
	return abs, nil
}

// isHiddenInfo 依据 Windows 文件属性判断隐藏
func isHiddenInfo(fi os.FileInfo) bool {
	if fi == nil {
		return false
	}
	if d, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		return d.FileAttributes&windows.FILE_ATTRIBUTE_HIDDEN != 0 ||
			d.FileAttributes&windows.FILE_ATTRIBUTE_SYSTEM != 0
	}
	return false
}

// revealInExplorer 在资源管理器中定位文件/目录
func revealInExplorer(path string) error {
	abs, err := toAbsWindowsPath(path)
	if err != nil {
		return err
	}
	if st, err := os.Stat(abs); err == nil {
		if st.IsDir() {
			return openFolder(abs)
		}
		if err := openAndSelectFile(abs); err == nil {
			return nil
		}
		// Shell API 不可用时退回命令行；无空格的路径这样也能正常工作
		return exec.Command("explorer", "/select,"+abs).Start()
	}
	// 文件已不存在（例如已被移入回收站）：退而打开所在目录，至少让用户看到位置
	if dir := filepath.Dir(abs); dir != "" && dir != abs {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return openFolder(dir)
		}
	}
	return fmt.Errorf("路径不存在：%s", abs)
}

// openFolder 在资源管理器中打开目录
func openFolder(dir string) error {
	return exec.Command("explorer", dir).Start()
}

// openAndSelectFile 打开文件所在目录并选中该文件。
//
// 用 SHOpenFolderAndSelectItems 而不是 exec explorer /select,<path>：
// 后者在路径含空格 / 中文时，Go 会把整个 "/select,C:\My Docs\a.jpg" 用引号包起来，
// explorer 解析不出正确的开关与路径，会退而打开「文档」库，看起来就像「定位跳到文档路径」。
func openAndSelectFile(abs string) error {
	p16, err := syscall.UTF16PtrFromString(abs)
	if err != nil {
		return err
	}
	pidl, _, _ := procILCreateFromPathW.Call(uintptr(unsafe.Pointer(p16)))
	if pidl == 0 {
		return fmt.Errorf("无法解析路径：%s", abs)
	}
	// 有意不调用 ILFree：调用返回后资源管理器窗口仍在异步初始化，过早释放可能崩。
	// 每次定位只泄漏一个 ITEMIDLIST（几十字节），可接受。
	ret, _, _ := procSHOpenFolderAndSelectItems.Call(pidl, 0, 0, 0)
	if int32(ret) < 0 {
		return fmt.Errorf("定位失败 (HRESULT 0x%08X)", uint32(ret))
	}
	return nil
}
