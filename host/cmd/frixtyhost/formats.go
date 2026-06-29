// Listformats handler: runs `yt-dlp -J` on a URL and returns the parsed
// format list to the popup.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/ilobaak/frixty-fetcher/host/internal/ytdlp"
)

func (s *server) handleListFormats(req request) {
	bin := s.ytBin()
	if bin == "" {
		s.sendRequestError(req.ReqID, "ytdlp_missing", "yt-dlp binary not found")
		return
	}
	log.Printf("[frixty/host] listFormats start url=%q cookies=%t", req.URL, req.CookiesText != "")
	ctx, cancel := context.WithTimeout(context.Background(), listFormatsTimeout)
	defer cancel()
	cookiesFile, cookiesCleanup, err := writeCookiesTemp(req.CookiesText)
	if err != nil {
		s.sendRequestError(req.ReqID, "cookies_write_failed", err.Error())
		return
	}
	defer cookiesCleanup()
	listing, err := ytdlp.ListFormats(ctx, bin, req.URL, cookiesFile)
	if err != nil {
		log.Printf("[frixty/host] listFormats error url=%q err=%v", req.URL, err)
		code, msg := "listformats_failed", err.Error()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "listformats_timeout"
			msg = fmt.Sprintf("yt-dlp -J did not return within %s", listFormatsTimeout)
		}
		s.sendRequestError(req.ReqID, code, msg)
		return
	}
	if len(listing.Formats) == 0 {
		// Galleries, image albums, and some playlist-style URLs parse cleanly
		// but expose no downloadable format. Surface that as a distinct code
		// rather than a generic failure.
		s.sendRequestError(req.ReqID, "no_formats", "no downloadable formats for this URL")
		log.Printf("[frixty/host] listFormats no_formats url=%q", req.URL)
		return
	}
	resp := map[string]any{
		"type":       "formats",
		"title":      listing.Title,
		"thumbnail":  listing.Thumbnail,
		"duration":   listing.Duration,
		"uploader":   listing.Uploader,
		"uploaderId": listing.UploaderID,
		"date":       listing.Date,
		"items":      listing.Formats,
	}
	s.send(withReqID(req, resp))
	log.Printf("[frixty/host] listFormats done url=%q formats=%d", req.URL, len(listing.Formats))
}
