// Native file/folder pickers. Each prompt* helper handles zenity
// error-reporting so callers just need a `if err != nil { return }`
// bail. Split out of main.go in sprint 2.
package main

import (
	"errors"
	"fmt"
	"path/filepath"

	"github.com/ncruces/zenity"
)

// promptSavePath opens the native Save As dialog and returns the chosen
// absolute path. On cancel, emits the job-scoped destdir_canceled error and
// returns a non-nil error so callers can bail; on other errors it emits
// picker_failed and returns the error. On success it also emits pathPicked
// so the SW can remember the parent dir as "last location".
func (s *server) promptSavePath(req request, defaultTitle string) (string, error) {
	title := req.DialogTitle
	if title == "" {
		title = defaultTitle
	}
	// zenity takes the default filename and start dir as one combined
	// Filename option: if the path is an existing directory the dialog
	// opens there, otherwise the basename is pre-filled.
	opts := []zenity.Option{zenity.Title(title)}
	defaultPath := req.DefaultFileName
	if req.StartDir != "" {
		if expanded, err := expandHome(req.StartDir); err == nil {
			if req.DefaultFileName != "" {
				defaultPath = filepath.Join(expanded, req.DefaultFileName)
			} else {
				defaultPath = expanded
			}
		}
	}
	if defaultPath != "" {
		opts = append(opts, zenity.Filename(defaultPath))
	}
	picked, err := zenity.SelectFileSave(opts...)
	if errors.Is(err, zenity.ErrCanceled) {
		s.sendJobError(req.JobID, "destdir_canceled", "save dialog canceled")
		return "", err
	}
	if err != nil {
		s.sendJobError(req.JobID, "picker_failed", err.Error())
		return "", err
	}
	// Announce the picked path so the SW can remember its parent folder
	// as the "last used location" even if the download later fails.
	s.send(map[string]any{
		"type":  "pathPicked",
		"jobId": req.JobID,
		"path":  picked,
	})
	return picked, nil
}

// promptGalleryItemPath opens a Save As dialog for one gallery item in
// askPerItem mode. Defaults the filename to the item's URL basename (or a
// sequential fallback); starts in the folder where the previous item was
// saved so a user walking through a gallery doesn't re-navigate every time.
func (s *server) promptGalleryItemPath(req request, item galleryItem, idx, total, digits int, prevPath string) (string, error) {
	defaultName := item.Name
	if defaultName == "" {
		ext := item.Ext
		if ext == "" {
			ext = "jpg"
		}
		defaultName = fmt.Sprintf("%0*d.%s", digits, idx+1, ext)
	}

	var startDir string
	if prevPath != "" {
		startDir = filepath.Dir(prevPath)
	} else if req.StartDir != "" {
		if expanded, err := expandHome(req.StartDir); err == nil {
			startDir = expanded
		}
	}

	title := fmt.Sprintf("Save item %d of %d", idx+1, total)
	opts := []zenity.Option{zenity.Title(title)}
	var defaultPath string
	if startDir != "" && defaultName != "" {
		defaultPath = filepath.Join(startDir, defaultName)
	} else if defaultName != "" {
		defaultPath = defaultName
	} else if startDir != "" {
		defaultPath = startDir
	}
	if defaultPath != "" {
		opts = append(opts, zenity.Filename(defaultPath))
	}
	return zenity.SelectFileSave(opts...)
}

// promptFolder opens a native folder picker for the gallery flow, mirroring
// promptSavePath's error-emission contract. A non-nil error means the caller
// should bail — a message was already sent to the extension.
func (s *server) promptFolder(req request, defaultTitle string) (string, error) {
	title := req.DialogTitle
	if title == "" {
		title = defaultTitle
	}
	opts := []zenity.Option{zenity.Title(title), zenity.Directory()}
	if req.StartDir != "" {
		if expanded, err := expandHome(req.StartDir); err == nil {
			opts = append(opts, zenity.Filename(expanded))
		}
	}
	picked, err := zenity.SelectFile(opts...)
	if errors.Is(err, zenity.ErrCanceled) {
		s.sendJobError(req.JobID, "destdir_canceled", "folder picker canceled")
		return "", err
	}
	if err != nil {
		s.sendJobError(req.JobID, "picker_failed", err.Error())
		return "", err
	}
	s.send(map[string]any{
		"type":  "pathPicked",
		"jobId": req.JobID,
		"path":  picked,
	})
	return picked, nil
}
