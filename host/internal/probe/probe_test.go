package probe

import "testing"

func TestCheck(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://www.youtube.com/watch?v=abc", true},
		{"https://youtu.be/abc", true},
		{"https://music.youtube.com/watch?v=abc", true},
		{"https://www.reddit.com/r/videos/comments/xyz/", true},
		{"https://v.redd.it/xyz", true},
		{"https://twitter.com/user/status/1", true},
		{"https://x.com/user/status/1", true},
		{"https://www.tiktok.com/@user/video/1", true},
		{"https://vm.tiktok.com/shortcode/", true},
		{"https://example.com/video", false},
		{"not a url", false},
		{"", false},
		// Ensure suffix match is not fooled by a similar-looking different host.
		{"https://notyoutube.com/", false},
	}
	for _, c := range cases {
		if got := Check(c.url); got != c.want {
			t.Errorf("Check(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
