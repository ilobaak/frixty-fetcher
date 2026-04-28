package ytdlp

import "testing"

func TestClassify(t *testing.T) {
	cases := []struct {
		v, a string
		want string
	}{
		{"avc1.640028", "mp4a.40.2", "combined"},
		{"avc1.640028", "none", "video"},
		{"none", "mp4a.40.2", "audio"},
		{"none", "none", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		if got := kind(c.v, c.a); got != c.want {
			t.Errorf("kind(%q,%q) = %q, want %q", c.v, c.a, got, c.want)
		}
	}
}

func TestClassifyDropsPseudoFormats(t *testing.T) {
	in := []rawFormat{
		{FormatID: "sb0", VCodec: "none", ACodec: "none"},
		{FormatID: "22", VCodec: "avc1", ACodec: "mp4a"},
	}
	got := classify(in)
	if len(got) != 1 || got[0].ID != "22" || got[0].Kind != "combined" {
		t.Errorf("classify dropped/kept the wrong format(s): %+v", got)
	}
}
