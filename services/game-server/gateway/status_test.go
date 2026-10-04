package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The ping probe answers from any origin with nothing to read, and only to
// GET (and HEAD): the browser times the round trip, nothing else.
func TestPingProbe(t *testing.T) {
	mux := (&server{}).statusMux()
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(method, "/ping", nil))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("%s /ping: status %d, want %d", method, recorder.Code, http.StatusNoContent)
		}
		if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Fatalf("%s /ping: Access-Control-Allow-Origin %q, want *", method, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s /ping: Cache-Control %q, want no-store", method, got)
		}
		if recorder.Body.Len() != 0 {
			t.Fatalf("%s /ping: body %q, want none", method, recorder.Body.String())
		}
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/ping", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /ping: status %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}
