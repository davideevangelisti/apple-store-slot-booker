import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase64Url, extractMessageText, htmlToText } from "../src/email.js";

test("decodes Gmail base64url bodies", () => {
  assert.equal(decodeBase64Url("SGVsbG8td29ybGQ"), "Hello-world");
});

test("extracts text/plain before text/html", () => {
  const payload = {
    parts: [
      { mimeType: "text/html", body: { data: "PGRpdj5IVE1MPC9kaXY" } },
      { mimeType: "text/plain", body: { data: "UGxhaW4gdGV4dA" } }
    ]
  };
  assert.equal(extractMessageText(payload), "Plain text");
});

test("converts simple html to readable text", () => {
  assert.equal(htmlToText("<p>Hello&nbsp;<b>Davide</b></p><p>Inbox &amp; drafts</p>"), "Hello Davide\nInbox & drafts");
});
