export type HeaderMap = Record<string, string>;

export function decodeBase64Url(data?: string | null): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function headersToMap(headers: Array<{ name?: string | null; value?: string | null }> = []): HeaderMap {
  const map: HeaderMap = {};
  for (const header of headers) {
    if (header.name && header.value) {
      map[header.name.toLowerCase()] = header.value;
    }
  }
  return map;
}

export function extractMessageText(payload: any): string {
  const plain: string[] = [];
  const html: string[] = [];

  function visit(part: any): void {
    if (!part) return;
    const mimeType = String(part.mimeType || "").toLowerCase();
    const bodyText = decodeBase64Url(part.body?.data);

    if (bodyText && mimeType === "text/plain") {
      plain.push(bodyText);
    } else if (bodyText && mimeType === "text/html") {
      html.push(htmlToText(bodyText));
    }

    for (const child of part.parts || []) {
      visit(child);
    }
  }

  visit(payload);
  const text = plain.join("\n\n").trim() || html.join("\n\n").trim();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
