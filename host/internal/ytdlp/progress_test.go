package ytdlp

import (
	"strings"
	"testing"
)

func TestParseStream(t *testing.T) {
	input := strings.Join([]string{
		`[YTDP]{"status":"downloading","downloaded_bytes":500,"total_bytes":1000,"speed":100.0,"eta":5}`,
		`[YTDP]{"status":"downloading","downloaded_bytes":1000,"total_bytes":1000,"speed":200.0,"eta":0}`,
		`[YTDP]{"status":"finished","downloaded_bytes":1000,"total_bytes":1000}`,
		`[download] irrelevant human line`,
		`[YTDP-DONE]C:\Users\test\Downloads\video.mp4`,
	}, "\n")

	var events []Progress
	path, leftover, err := ParseStream(strings.NewReader(input), func(p Progress) {
		events = append(events, p)
	})
	if err != nil {
		t.Fatalf("ParseStream: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %+v", len(events), events)
	}
	if events[0].Percent != 50 {
		t.Errorf("events[0].Percent = %v, want 50", events[0].Percent)
	}
	if events[0].Stage != "download" || events[2].Stage != "postprocess" {
		t.Errorf("stage progression wrong: %+v", events)
	}
	if path != `C:\Users\test\Downloads\video.mp4` {
		t.Errorf("path = %q", path)
	}
	// "[download] irrelevant human line" is neither progress nor done;
	// ParseStream should capture it as leftover so the caller can
	// surface it on failure.
	if !strings.Contains(leftover, "irrelevant human line") {
		t.Errorf("expected leftover to include non-progress stdout; got %q", leftover)
	}
}

func TestParseStreamEstimatedTotal(t *testing.T) {
	input := `[YTDP]{"status":"downloading","downloaded_bytes":250,"total_bytes_estimate":1000,"speed":50}`
	var events []Progress
	if _, _, err := ParseStream(strings.NewReader(input), func(p Progress) { events = append(events, p) }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Percent != 25 {
		t.Errorf("expected 25%% from total_bytes_estimate, got %+v", events)
	}
}
