package main

import (
	"errors"
	"strings"
	"testing"
)

// TestFormatDownloadErrBareExit: no stderr, no stdout leftover. Should
// fall back to exit status + condensed argv dump so the user has
// SOMETHING to paste into a terminal for reproduction.
func TestFormatDownloadErrBareExit(t *testing.T) {
	argv := []string{"--no-warnings", "-f", "bestvideo+bestaudio/best", "https://example/"}
	got := formatDownloadErr(errors.New("exit status 1"), "", "", argv)
	if !strings.Contains(got, "exit status 1") {
		t.Errorf("missing exit status in %q", got)
	}
	if !strings.Contains(got, "yt-dlp") || !strings.Contains(got, "https://example/") {
		t.Errorf("expected condensed argv in %q", got)
	}
	if !strings.Contains(got, "no diagnostic") {
		t.Errorf("expected silent-failure marker in %q", got)
	}
}

// TestFormatDownloadErrExtractsErrorLine: the ERROR: line yt-dlp
// emits is what the user needs; it should lead the message.
func TestFormatDownloadErrExtractsErrorLine(t *testing.T) {
	stderr := "[facebook] Extracting URL: ...\n" +
		"ERROR: [facebook] 1234567: Login required to view this video\n"
	got := formatDownloadErr(errors.New("exit status 1"), stderr, "", nil)
	if !strings.Contains(got, "ERROR: [facebook] 1234567: Login required to view this video") {
		t.Errorf("missing ERROR line in %q", got)
	}
}

// TestFormatDownloadErrMultipleErrorsJoin: a run that fails with
// both a primary error AND a post-process error surfaces both.
func TestFormatDownloadErrMultipleErrorsJoin(t *testing.T) {
	stderr := "ERROR: first thing broke\nsome noise\nERROR: then cleanup failed too\n"
	got := formatDownloadErr(errors.New("exit status 1"), stderr, "", nil)
	if !strings.Contains(got, "ERROR: first thing broke") || !strings.Contains(got, "ERROR: then cleanup failed too") {
		t.Errorf("expected both ERROR lines; got %q", got)
	}
}

// TestFormatDownloadErrFallsBackToLastStderrLine: yt-dlp (or ffmpeg)
// sometimes crashes before emitting a structured ERROR: line. Surface
// whatever the final line of stderr was rather than silent-failure.
func TestFormatDownloadErrFallsBackToLastStderrLine(t *testing.T) {
	stderr := "[generic] Extracting URL: https://example.com/foo\n" +
		"traceback ...\n" +
		"RuntimeError: something exploded\n"
	got := formatDownloadErr(errors.New("exit status 1"), stderr, "", nil)
	if !strings.Contains(got, "RuntimeError: something exploded") {
		t.Errorf("fallback should include last non-empty stderr line; got %q", got)
	}
}

// TestFormatDownloadErrUsesStdoutWhenStderrEmpty: some yt-dlp failure
// modes (format-selection errors in recent builds) put ERRORs on
// stdout instead of stderr. Surface them.
func TestFormatDownloadErrUsesStdoutWhenStderrEmpty(t *testing.T) {
	stdoutLeftover := "ERROR: Requested format is not available. Use --list-formats"
	got := formatDownloadErr(errors.New("exit status 1"), "", stdoutLeftover, nil)
	if !strings.Contains(got, "Requested format is not available") {
		t.Errorf("stdout ERROR not surfaced; got %q", got)
	}
}

// TestFormatDownloadErrHandlesCRLF: Windows yt-dlp builds emit CRLF
// line endings; trimming should be robust.
func TestFormatDownloadErrHandlesCRLF(t *testing.T) {
	stderr := "noise\r\nERROR: private video\r\n"
	got := formatDownloadErr(errors.New("exit status 1"), stderr, "", nil)
	if !strings.Contains(got, "ERROR: private video") {
		t.Errorf("CRLF stderr mangled; got %q", got)
	}
	if strings.Contains(got, "\r") {
		t.Errorf("\\r leaked into output: %q", got)
	}
}

// TestCondensedArgvStripsNoisyFlags: the --progress-template / --print
// format strings are useless noise in an error display. Drop them +
// their values; keep everything else including the URL.
func TestCondensedArgvStripsNoisyFlags(t *testing.T) {
	argv := []string{
		"--no-warnings",
		"--progress-template", "[YTDP]%(progress)j",
		"--print", "after_move:[YTDP-DONE]%(filepath)s",
		"-f", "bestvideo+bestaudio/best",
		"-o", "C:\\Users\\me\\Desktop\\foo.mp4",
		"https://facebook.com/photo/?fbid=1",
	}
	got := condensedArgv(argv)
	for _, want := range []string{"-f", "bestvideo+bestaudio/best", "https://facebook.com/photo/?fbid=1"} {
		if !strings.Contains(got, want) {
			t.Errorf("condensed argv missing %q: %q", want, got)
		}
	}
	for _, unwanted := range []string{"--progress-template", "--print", "%(progress)j"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("condensed argv kept %q: %q", unwanted, got)
		}
	}
}
