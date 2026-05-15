import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import express, { Response } from "express";
import { gmail as createGmail } from "googleapis/build/src/apis/gmail/index.js";
import { OAuth2Client } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import * as z from "zod/v4";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { base64UrlEncode, extractMessageText, headersToMap } from "./email.js";
import { startAppleStoreChecker, checkAvailability, type AppleStoreCheckerConfig, type AppleStoreAutoBookConfig } from "./apple-store-checker.js";

type Config = {
  port: number;
  host: string;
  allowedHosts: string[];
  publicBaseUrl: string;
  resourceUrl: URL;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleScopes: string[];
  mcpScopes: string[];
  storePath: string;
  accessTokenTtlSeconds: number;
  reminderCheckIntervalSeconds: number;
  appleStore: AppleStoreCheckerConfig & { enabled: boolean } | null;
  telegram: { botToken: string; chatId: string } | null;
};

type StoredAuthorizationParams = {
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
};

type PendingGoogleState = {
  clientId: string;
  params: StoredAuthorizationParams;
  createdAt: number;
};

type StoredAuthorizationCode = PendingGoogleState & {
  gmailEmail: string;
  expiresAt: number;
};

type StoredAppToken = {
  clientId: string;
  gmailEmail: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
};

type StoredRefreshToken = {
  clientId: string;
  gmailEmail: string;
  scopes: string[];
  resource?: string;
};

type StoredGoogleAccount = {
  email: string;
  tokens: Credentials;
  updatedAt: number;
};

type ReminderTargetType = "message" | "thread";
type ReminderStatus = "scheduled" | "completed" | "cancelled";

type StoredReminder = {
  id: string;
  gmailEmail: string;
  targetType: ReminderTargetType;
  targetId: string;
  remindAt: string;
  note?: string;
  hideUntilDue: boolean;
  returnToInboxWhenDue: boolean;
  markUnreadWhenDue: boolean;
  starWhenDue: boolean;
  status: ReminderStatus;
  createdAt: number;
  completedAt?: number;
  cancelledAt?: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

type StoreData = {
  clients: Record<string, OAuthClientInformationFull>;
  googleStates: Record<string, PendingGoogleState>;
  authorizationCodes: Record<string, StoredAuthorizationCode>;
  accessTokens: Record<string, StoredAppToken>;
  refreshTokens: Record<string, StoredRefreshToken>;
  googleAccounts: Record<string, StoredGoogleAccount>;
  reminders: Record<string, StoredReminder>;
};

const emptyStore = (): StoreData => ({
  clients: {},
  googleStates: {},
  authorizationCodes: {},
  accessTokens: {},
  refreshTokens: {},
  googleAccounts: {},
  reminders: {}
});

const REMINDER_BASE_LABEL = "MCP/Reminders";
const REMINDER_SCHEDULED_LABEL = "MCP/Reminders/Scheduled";
const REMINDER_DUE_LABEL = "MCP/Reminders/Due";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function splitList(value: string | undefined, fallback: string[]): string[] {
  const raw = value?.trim();
  if (!raw) return fallback;
  return raw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function loadConfig(): Config {
  const port = Number(process.env.PORT || 3000);
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/g, "");
  const publicHostname = new URL(publicBaseUrl).hostname;
  const allowedHosts = Array.from(new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    publicHostname,
    ...splitList(process.env.ALLOWED_HOSTS, [])
  ].filter(Boolean)));

  return {
    port,
    host: process.env.HOST || "127.0.0.1",
    allowedHosts,
    publicBaseUrl,
    resourceUrl: new URL("/mcp", publicBaseUrl),
    googleClientId: requiredEnv("GOOGLE_CLIENT_ID"),
    googleClientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || new URL("/oauth/google/callback", publicBaseUrl).href,
    googleScopes: splitList(process.env.GOOGLE_SCOPES, [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send"
    ]),
    mcpScopes: splitList(process.env.MCP_SCOPES, ["gmail.read", "gmail.draft", "gmail.modify", "gmail.send"]),
    storePath: resolve(process.env.STORE_PATH || "data/store.json"),
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600),
    reminderCheckIntervalSeconds: Number(process.env.REMINDER_CHECK_INTERVAL_SECONDS || 60),
    telegram: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    } : null,
    appleStore: process.env.APPLE_STORE_ENABLED === "true" ? {
      enabled: true,
      storeId: process.env.APPLE_STORE_ID || "R045",
      storeName: process.env.APPLE_STORE_NAME || "Apple Rosenstrasse, Munich",
      issueDescription: process.env.APPLE_STORE_ISSUE || "AirPods repair",
      notifyEmail: requiredEnv("APPLE_STORE_NOTIFY_EMAIL"),
      checkIntervalSeconds: Number(process.env.APPLE_STORE_CHECK_INTERVAL_SECONDS || 1800),
      saturdayMorningIntervalSeconds: Number(process.env.APPLE_STORE_SAT_MORNING_INTERVAL_SECONDS || 300),
      autoBook: process.env.APPLE_STORE_AUTO_BOOK === "true" ? (() => {
        const ab: AppleStoreAutoBookConfig = {
          firstName: requiredEnv("APPLE_BOOKING_FIRST_NAME"),
          lastName: requiredEnv("APPLE_BOOKING_LAST_NAME"),
          phone: requiredEnv("APPLE_BOOKING_PHONE"),
          email: process.env.APPLE_BOOKING_EMAIL || requiredEnv("APPLE_STORE_NOTIFY_EMAIL"),
          slotTier1StartHour: Number(process.env.APPLE_BOOKING_SLOT_TIER1_START || 9),
          slotTier1EndHour: Number(process.env.APPLE_BOOKING_SLOT_TIER1_END || 10),
          debugDir: process.env.APPLE_BOOKING_DEBUG_DIR || undefined,
        };
        return ab;
      })() : undefined,
    } : null
  };
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error(`Telegram API error ${res.status}: ${await res.text()}`);
}

function msTilNextMunichHour(hour: number): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  const todayAtHour = new Date(`${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:00:00`);
  // Convert Munich local time string to UTC by finding the offset
  const munichOffsetMs = now.getTime() - new Date(formatter.format(now)).getTime();
  const targetUtc = todayAtHour.getTime() - munichOffsetMs;
  const ms = targetUtc - now.getTime();
  return ms > 0 ? ms : ms + 24 * 60 * 60 * 1000;
}

function startDailyRecap(
  telegram: { botToken: string; chatId: string },
  appleStoreConfig: AppleStoreCheckerConfig,
  recapHour: number
): void {
  const send = async () => {
    try {
      const result = await checkAvailability(appleStoreConfig);
      const slots = result.saturdayAdvanceSlotUtcHours.length > 0
        ? `✅ Advance slots visible for ${result.saturdayDate}`
        : `🔍 No advance slots yet for ${result.saturdayDate}`;
      const text = [
        `<b>🍎 Daily recap — ${new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", weekday: "long", day: "2-digit", month: "2-digit" })}</b>`,
        ``,
        `Store: ${result.storeName}`,
        `Next Saturday: ${result.saturdayDate}`,
        slots,
        `Last check: ${new Date(result.checkedAt).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })} Munich`,
        ``,
        `Service is running ✓`
      ].join("\n");
      await sendTelegramMessage(telegram.botToken, telegram.chatId, text);
    } catch (err) {
      console.error("[Daily recap] Failed to send:", err);
    }
    setTimeout(send, msTilNextMunichHour(recapHour));
  };

  setTimeout(send, msTilNextMunichHour(recapHour));
  console.log(`Daily recap scheduled at ${recapHour}:00 Munich time`);
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function sameUrl(left?: string | URL, right?: string | URL): boolean {
  if (!left || !right) return false;
  return new URL(left.toString()).href.replace(/\/$/g, "") === new URL(right.toString()).href.replace(/\/$/g, "");
}

class JsonStore implements OAuthRegisteredClientsStore {
  private data?: StoreData;

  constructor(private readonly path: string) {}

  async all(): Promise<StoreData> {
    if (this.data) return this.data;
    try {
      this.data = { ...emptyStore(), ...JSON.parse(await readFile(this.path, "utf8")) };
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.data = emptyStore();
      await this.save();
    }
    if (!this.data) this.data = emptyStore();
    return this.data;
  }

  async save(): Promise<void> {
    if (!this.data) this.data = emptyStore();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return (await this.all()).clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const data = await this.all();
    if (!client.client_id) throw new Error("OAuth client registration did not include client_id");
    data.clients[client.client_id] = client;
    await this.save();
    return client;
  }
}

class GmailOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly config: Config, private readonly store: JsonStore) {
    this.clientsStore = store;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    try {
      if (!client.redirect_uris?.includes(params.redirectUri)) {
        throw new Error("Unregistered redirect_uri");
      }

      const state = token();
      const data = await this.store.all();
      data.googleStates[state] = {
        clientId: client.client_id,
        params: {
          state: params.state,
          scopes: params.scopes?.length ? params.scopes : this.config.mcpScopes,
          codeChallenge: params.codeChallenge,
          redirectUri: params.redirectUri,
          resource: params.resource?.href
        },
        createdAt: Date.now()
      };
      await this.store.save();

      const googleClient = this.googleOAuthClient();
      const authorizationUrl = googleClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: true,
        redirect_uri: this.config.googleRedirectUri,
        scope: this.config.googleScopes,
        state
      });
      res.redirect(authorizationUrl);
    } catch (error) {
      console.error("OAuth authorize failed", error);
      throw error;
    }
  }

  async handleGoogleCallback(query: Record<string, unknown>, res: Response): Promise<void> {
    const state = typeof query.state === "string" ? query.state : "";
    const code = typeof query.code === "string" ? query.code : "";
    const data = await this.store.all();
    const pending = data.googleStates[state];
    delete data.googleStates[state];

    if (!pending || !code) {
      await this.store.save();
      res.status(400).send("Invalid or expired Google OAuth callback.");
      return;
    }

    const googleClient = this.googleOAuthClient();
    const { tokens } = await googleClient.getToken(code);
    googleClient.setCredentials(tokens);

    const gmail = createGmail({ version: "v1", auth: googleClient });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;
    if (!email) throw new Error("Google did not return a Gmail email address.");

    const previous = data.googleAccounts[email]?.tokens || {};
    data.googleAccounts[email] = {
      email,
      tokens: { ...previous, ...tokens },
      updatedAt: Date.now()
    };

    const appCode = token();
    data.authorizationCodes[appCode] = {
      ...pending,
      gmailEmail: email,
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    await this.store.save();

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", appCode);
    if (pending.params.state) target.searchParams.set("state", pending.params.state);
    res.redirect(target.href);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = (await this.store.all()).authorizationCodes[authorizationCode];
    if (!code || code.expiresAt < Date.now()) throw new Error("Invalid or expired authorization code");
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const data = await this.store.all();
    const code = data.authorizationCodes[authorizationCode];
    if (!code || code.expiresAt < Date.now()) throw new Error("Invalid or expired authorization code");
    if (code.clientId !== client.client_id) throw new Error("Authorization code was issued to a different client");
    if (redirectUri && redirectUri !== code.params.redirectUri) throw new Error("redirect_uri does not match");
    if (resource && !sameUrl(resource, this.config.resourceUrl)) throw new Error("Invalid resource");

    delete data.authorizationCodes[authorizationCode];
    const accessToken = token();
    const refreshToken = token();
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.accessTokenTtlSeconds;
    const resourceValue = code.params.resource || this.config.resourceUrl.href;

    data.accessTokens[accessToken] = {
      clientId: client.client_id,
      gmailEmail: code.gmailEmail,
      scopes: code.params.scopes,
      expiresAt,
      resource: resourceValue
    };
    data.refreshTokens[refreshToken] = {
      clientId: client.client_id,
      gmailEmail: code.gmailEmail,
      scopes: code.params.scopes,
      resource: resourceValue
    };
    await this.store.save();

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: code.params.scopes.join(" ")
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const data = await this.store.all();
    const existing = data.refreshTokens[refreshToken];
    if (!existing || existing.clientId !== client.client_id) throw new Error("Invalid refresh token");
    if (resource && !sameUrl(resource, existing.resource || this.config.resourceUrl)) throw new Error("Invalid resource");

    const requestedScopes = scopes?.length ? scopes : existing.scopes;
    for (const scope of requestedScopes) {
      if (!existing.scopes.includes(scope)) throw new Error(`Refresh token is not authorized for ${scope}`);
    }

    const accessToken = token();
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.accessTokenTtlSeconds;
    data.accessTokens[accessToken] = {
      clientId: client.client_id,
      gmailEmail: existing.gmailEmail,
      scopes: requestedScopes,
      expiresAt,
      resource: existing.resource
    };
    await this.store.save();

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: requestedScopes.join(" ")
    };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const tokenData = (await this.store.all()).accessTokens[accessToken];
    if (!tokenData || tokenData.expiresAt < Date.now() / 1000) {
      throw new Error("Invalid or expired token");
    }
    return {
      token: accessToken,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: tokenData.expiresAt,
      resource: new URL(tokenData.resource || this.config.resourceUrl.href),
      extra: { gmailEmail: tokenData.gmailEmail }
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const data = await this.store.all();
    if (data.accessTokens[request.token]?.clientId === client.client_id) delete data.accessTokens[request.token];
    if (data.refreshTokens[request.token]?.clientId === client.client_id) delete data.refreshTokens[request.token];
    await this.store.save();
  }

  async gmailFor(email: string) {
    const data = await this.store.all();
    const account = data.googleAccounts[email];
    if (!account) throw new Error(`No Google account is connected for ${email}`);

    const client = this.googleOAuthClient();
    client.setCredentials(account.tokens);
    client.on("tokens", async (tokens) => {
      const latest = await this.store.all();
      latest.googleAccounts[email] = {
        email,
        tokens: { ...latest.googleAccounts[email]?.tokens, ...tokens },
        updatedAt: Date.now()
      };
      await this.store.save();
    });

    return createGmail({ version: "v1", auth: client });
  }

  private googleOAuthClient(): OAuth2Client {
    return new OAuth2Client(
      this.config.googleClientId,
      this.config.googleClientSecret,
      this.config.googleRedirectUri
    );
  }
}

function gmailEmailFromAuth(authInfo?: AuthInfo): string {
  const email = authInfo?.extra?.gmailEmail;
  if (typeof email !== "string" || !email) throw new Error("No Gmail account is connected for this MCP token");
  return email;
}

function gmailMessageUrl(id: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
}

function normalizeGmailMessageId(id: string): string {
  return id.replace(/^message:/, "");
}

function normalizeGmailThreadId(id: string): string {
  return id.replace(/^thread:/, "");
}

async function getMessage(gmail: any, id: string, format: "metadata" | "full" = "full") {
  const response = await gmail.users.messages.get({
    userId: "me",
    id: id.replace(/^message:/, ""),
    format,
    metadataHeaders: ["Subject", "From", "To", "Cc", "Date", "Message-ID"]
  });
  return response.data;
}

function summarizeMessage(message: any) {
  const headers = headersToMap(message.payload?.headers || []);
  return {
    id: message.id,
    threadId: message.threadId,
    title: headers.subject || "(no subject)",
    subject: headers.subject || "",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || "",
    snippet: message.snippet || "",
    url: gmailMessageUrl(message.id)
  };
}

function fullMessageDocument(message: any) {
  const headers = headersToMap(message.payload?.headers || []);
  const text = extractMessageText(message.payload) || message.snippet || "";
  const title = headers.subject || "(no subject)";
  return {
    id: message.id,
    title,
    text: [
      `Subject: ${title}`,
      headers.from ? `From: ${headers.from}` : "",
      headers.to ? `To: ${headers.to}` : "",
      headers.cc ? `Cc: ${headers.cc}` : "",
      headers.date ? `Date: ${headers.date}` : "",
      "",
      text
    ].filter((line) => line !== "").join("\n"),
    url: gmailMessageUrl(message.id),
    metadata: {
      threadId: message.threadId,
      labels: message.labelIds || [],
      from: headers.from || "",
      to: headers.to || "",
      cc: headers.cc || "",
      date: headers.date || "",
      messageId: headers["message-id"] || ""
    }
  };
}

async function searchMessages(gmail: any, query: string, maxResults: number) {
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
    includeSpamTrash: false
  });
  const messages = list.data.messages || [];
  return Promise.all(messages.map(async (item: any) => summarizeMessage(await getMessage(gmail, item.id, "metadata"))));
}

type OutboundEmailInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
};

type GmailLabel = {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  messageListVisibility?: string | null;
  labelListVisibility?: string | null;
};

function buildMessageRaw(input: OutboundEmailInput): string {
  const header = (value?: string) => (value || "").replace(/[\r\n]+/g, " ").trim();
  const lines = [
    `To: ${header(input.to)}`,
    input.cc ? `Cc: ${header(input.cc)}` : "",
    input.bcc ? `Bcc: ${header(input.bcc)}` : "",
    `Subject: ${header(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body
  ].filter((line) => line !== "");
  return base64UrlEncode(lines.join("\r\n"));
}

async function listGmailLabels(gmail: any): Promise<GmailLabel[]> {
  const response = await gmail.users.labels.list({ userId: "me" });
  return response.data.labels || [];
}

function labelKey(value: string): string {
  return value.trim().toLowerCase();
}

function publicLabel(label: GmailLabel) {
  return {
    id: label.id,
    name: label.name,
    type: label.type,
    messageListVisibility: label.messageListVisibility,
    labelListVisibility: label.labelListVisibility
  };
}

async function resolveLabelIds(gmail: any, labels: string[]): Promise<Array<{ input: string; id: string; name?: string | null }>> {
  if (!labels.length) return [];

  const available = await listGmailLabels(gmail);
  const byId = new Map<string, GmailLabel>();
  const byName = new Map<string, GmailLabel>();

  for (const label of available) {
    if (label.id) byId.set(label.id, label);
    if (label.name) byName.set(labelKey(label.name), label);
  }

  return labels.map((input) => {
    const trimmed = input.trim();
    const label = byId.get(trimmed) || byName.get(labelKey(trimmed));
    if (!label?.id) {
      throw new Error(`Gmail label not found: ${input}`);
    }
    return { input, id: label.id, name: label.name };
  });
}

async function resolveOrCreateLabelId(
  gmail: any,
  label: string,
  createIfMissing: boolean
): Promise<{ id: string; name?: string | null; created: boolean }> {
  try {
    const [resolved] = await resolveLabelIds(gmail, [label]);
    return { id: resolved.id, name: resolved.name, created: false };
  } catch (error) {
    if (!createIfMissing) throw error;
  }

  const response = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: label.trim(),
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    }
  });

  if (!response.data.id) {
    throw new Error(`Gmail did not return an id for the created label: ${label}`);
  }

  return { id: response.data.id, name: response.data.name, created: true };
}

async function ensureReminderLabels(gmail: any): Promise<{
  base: { id: string; name?: string | null; created: boolean };
  scheduled: { id: string; name?: string | null; created: boolean };
  due: { id: string; name?: string | null; created: boolean };
}> {
  const base = await resolveOrCreateLabelId(gmail, REMINDER_BASE_LABEL, true);
  const scheduled = await resolveOrCreateLabelId(gmail, REMINDER_SCHEDULED_LABEL, true);
  const due = await resolveOrCreateLabelId(gmail, REMINDER_DUE_LABEL, true);
  return { base, scheduled, due };
}

function parseReminderTime(value: string): { iso: string; timestamp: number } {
  const trimmed = value.trim();
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    throw new Error("remind_at must be an ISO 8601 timestamp with a timezone, for example 2026-05-15T09:00:00+02:00");
  }
  const timestamp = new Date(trimmed).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("remind_at must be a valid ISO 8601 timestamp.");
  }
  return { iso: new Date(timestamp).toISOString(), timestamp };
}

function publicReminder(reminder: StoredReminder) {
  return {
    id: reminder.id,
    targetType: reminder.targetType,
    targetId: reminder.targetId,
    targetUrl: gmailMessageUrl(reminder.targetId),
    remindAt: reminder.remindAt,
    note: reminder.note,
    status: reminder.status,
    hideUntilDue: reminder.hideUntilDue,
    returnToInboxWhenDue: reminder.returnToInboxWhenDue,
    markUnreadWhenDue: reminder.markUnreadWhenDue,
    starWhenDue: reminder.starWhenDue,
    createdAt: new Date(reminder.createdAt).toISOString(),
    completedAt: reminder.completedAt ? new Date(reminder.completedAt).toISOString() : undefined,
    cancelledAt: reminder.cancelledAt ? new Date(reminder.cancelledAt).toISOString() : undefined,
    attempts: reminder.attempts,
    lastAttemptAt: reminder.lastAttemptAt ? new Date(reminder.lastAttemptAt).toISOString() : undefined,
    lastError: reminder.lastError
  };
}

async function modifyGmailTargetLabels(
  gmail: any,
  targetType: ReminderTargetType,
  targetId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
) {
  const requestBody = { addLabelIds, removeLabelIds };
  if (targetType === "thread") {
    const response = await gmail.users.threads.modify({
      userId: "me",
      id: normalizeGmailThreadId(targetId),
      requestBody
    });
    return {
      threadId: response.data.id,
      messageIds: (response.data.messages || []).map((message: any) => message.id).filter(Boolean),
      labelIds: Array.from(new Set((response.data.messages || []).flatMap((message: any) => message.labelIds || [])))
    };
  }

  const response = await gmail.users.messages.modify({
    userId: "me",
    id: normalizeGmailMessageId(targetId),
    requestBody
  });
  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
    labelIds: response.data.labelIds || []
  };
}

async function deliverReminder(provider: GmailOAuthProvider, store: JsonStore, reminder: StoredReminder) {
  const now = Date.now();
  try {
    const gmail = await provider.gmailFor(reminder.gmailEmail);
    const labels = await ensureReminderLabels(gmail);
    const addLabelIds = [labels.due.id];
    if (reminder.returnToInboxWhenDue) addLabelIds.push("INBOX");
    if (reminder.markUnreadWhenDue) addLabelIds.push("UNREAD");
    if (reminder.starWhenDue) addLabelIds.push("STARRED");

    const modified = await modifyGmailTargetLabels(
      gmail,
      reminder.targetType,
      reminder.targetId,
      addLabelIds,
      [labels.scheduled.id]
    );

    const data = await store.all();
    const current = data.reminders[reminder.id];
    if (current?.status === "scheduled") {
      data.reminders[reminder.id] = {
        ...current,
        status: "completed",
        completedAt: now,
        attempts: current.attempts + 1,
        lastAttemptAt: now,
        lastError: undefined
      };
      await store.save();
    }

    return {
      reminderId: reminder.id,
      status: "completed",
      targetType: reminder.targetType,
      targetId: reminder.targetId,
      modified
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const data = await store.all();
    const current = data.reminders[reminder.id];
    if (current?.status === "scheduled") {
      data.reminders[reminder.id] = {
        ...current,
        attempts: current.attempts + 1,
        lastAttemptAt: now,
        lastError: message
      };
      await store.save();
    }
    return {
      reminderId: reminder.id,
      status: "failed",
      targetType: reminder.targetType,
      targetId: reminder.targetId,
      error: message
    };
  }
}

async function deliverDueReminders(
  provider: GmailOAuthProvider,
  store: JsonStore,
  options: { gmailEmail?: string; maxResults?: number } = {}
) {
  const now = Date.now();
  const maxResults = options.maxResults ?? 20;
  const data = await store.all();
  const due = Object.values(data.reminders)
    .filter((reminder) => reminder.status === "scheduled")
    .filter((reminder) => !options.gmailEmail || reminder.gmailEmail === options.gmailEmail)
    .filter((reminder) => new Date(reminder.remindAt).getTime() <= now)
    .sort((left, right) => new Date(left.remindAt).getTime() - new Date(right.remindAt).getTime())
    .slice(0, maxResults);

  const results = [];
  for (const reminder of due) {
    results.push(await deliverReminder(provider, store, reminder));
  }
  return results;
}

function startReminderScheduler(provider: GmailOAuthProvider, store: JsonStore, intervalSeconds: number) {
  const run = async () => {
    try {
      const results = await deliverDueReminders(provider, store, { maxResults: 50 });
      if (results.length) {
        console.log(`Processed ${results.length} due Gmail reminder(s).`);
      }
    } catch (error) {
      console.error("Failed to process due Gmail reminders", error);
    }
  };

  const timer = setInterval(run, Math.max(10, intervalSeconds) * 1000);
  timer.unref?.();
  setTimeout(run, 10 * 1000).unref?.();
  return timer;
}

function createServer(provider: GmailOAuthProvider, store: JsonStore, config: Config): McpServer {
  const server = new McpServer(
    {
      name: "gmail-chatgpt-mcp",
      version: "0.1.0",
      websiteUrl: "https://mail.google.com"
    },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "search",
    {
      title: "Search Gmail",
      description: "Search Gmail messages using Gmail search syntax or natural keywords. Returns citation-ready message results.",
      inputSchema: {
        query: z.string().min(1).describe("Gmail search query, for example from:alice@example.com newer_than:30d invoice"),
        max_results: z.number().int().min(1).max(20).default(10)
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ query, max_results }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const results = await searchMessages(gmail, query, max_results);
      return {
        structuredContent: { results },
        content: [{ type: "text", text: JSON.stringify({ results }) }]
      };
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Gmail Message",
      description: "Fetch the full normalized text and metadata for a Gmail message returned by search.",
      inputSchema: {
        id: z.string().min(1).describe("Gmail message id returned by search")
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const document = fullMessageDocument(await getMessage(gmail, id, "full"));
      return {
        structuredContent: document,
        content: [{ type: "text", text: JSON.stringify(document) }]
      };
    }
  );

  server.registerTool(
    "gmail_get_thread",
    {
      title: "Get Gmail Thread",
      description: "Fetch every message in a Gmail thread with normalized text and headers.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Gmail thread id")
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ thread_id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.threads.get({ userId: "me", id: thread_id, format: "full" });
      const messages = (response.data.messages || []).map(fullMessageDocument);
      return {
        structuredContent: { threadId: thread_id, messages },
        content: [{ type: "text", text: JSON.stringify({ threadId: thread_id, messages }) }]
      };
    }
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create Gmail Draft",
      description: "Create a Gmail draft. This does not send email.",
      inputSchema: {
        to: z.string().min(1),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().min(1),
        body: z.string().min(1)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async (input, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: buildMessageRaw(input) } }
      });
      const result = {
        draftId: response.data.id,
        messageId: response.data.message?.id,
        messageUrl: response.data.message?.id ? gmailMessageUrl(response.data.message.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_send_email",
    {
      title: "Send Gmail Email",
      description: "Send a plain-text email from the connected Gmail account.",
      inputSchema: {
        to: z.string().min(1).describe("Recipient email address or comma-separated recipient list"),
        cc: z.string().optional().describe("Optional comma-separated Cc recipients"),
        bcc: z.string().optional().describe("Optional comma-separated Bcc recipients"),
        subject: z.string().min(1),
        body: z.string().min(1),
        thread_id: z.string().optional().describe("Optional Gmail thread id for sending in an existing thread")
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
    },
    async (input, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: buildMessageRaw(input),
          threadId: input.thread_id
        }
      });
      const result = {
        messageId: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds || [],
        messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "List Gmail Labels",
      description: "List Gmail system and user labels. Gmail folders are represented as labels.",
      inputSchema: {
        include_system: z.boolean().default(true).describe("Include system labels such as INBOX, SENT, TRASH, and SPAM")
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ include_system }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const labels = (await listGmailLabels(gmail))
        .filter((label) => include_system || label.type !== "system")
        .map(publicLabel);
      return {
        structuredContent: { labels },
        content: [{ type: "text", text: JSON.stringify({ labels }) }]
      };
    }
  );

  server.registerTool(
    "gmail_create_label",
    {
      title: "Create Gmail Label",
      description: "Create a Gmail user label, which appears like a folder in Gmail.",
      inputSchema: {
        name: z.string().min(1).describe("New label/folder name"),
        show_in_label_list: z.boolean().default(true),
        show_in_message_list: z.boolean().default(true)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ name, show_in_label_list, show_in_message_list }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: name.trim(),
          labelListVisibility: show_in_label_list ? "labelShow" : "labelHide",
          messageListVisibility: show_in_message_list ? "show" : "hide"
        }
      });
      const result = { label: publicLabel(response.data) };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_modify_message_labels",
    {
      title: "Modify Gmail Message Labels",
      description: "Add or remove Gmail labels/folders on a message. Accepts label IDs such as INBOX or user-visible label names.",
      inputSchema: {
        message_id: z.string().min(1).describe("Gmail message id"),
        add_labels: z.array(z.string().min(1)).default([]).describe("Label IDs or names to add"),
        remove_labels: z.array(z.string().min(1)).default([]).describe("Label IDs or names to remove")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ message_id, add_labels, remove_labels }, extra) => {
      if (!add_labels.length && !remove_labels.length) {
        throw new Error("Provide at least one label to add or remove.");
      }

      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const add = await resolveLabelIds(gmail, add_labels);
      const remove = await resolveLabelIds(gmail, remove_labels);
      const response = await gmail.users.messages.modify({
        userId: "me",
        id: message_id.replace(/^message:/, ""),
        requestBody: {
          addLabelIds: add.map((label) => label.id),
          removeLabelIds: remove.map((label) => label.id)
        }
      });
      const result = {
        messageId: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds || [],
        added: add,
        removed: remove,
        messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_move_message",
    {
      title: "Move Gmail Message",
      description: "Move a Gmail message to a label/folder. Use destination_label=archive to archive or trash/bin to move to trash.",
      inputSchema: {
        message_id: z.string().min(1).describe("Gmail message id"),
        destination_label: z.string().min(1).describe("Destination Gmail label/folder name or id, or archive/trash"),
        remove_from_inbox: z.boolean().default(true).describe("Remove INBOX while applying the destination label"),
        create_label_if_missing: z.boolean().default(false).describe("Create the destination label if it does not exist")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ message_id, destination_label, remove_from_inbox, create_label_if_missing }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const id = message_id.replace(/^message:/, "");
      const normalizedDestination = labelKey(destination_label);

      if (["trash", "bin"].includes(normalizedDestination)) {
        const response = await gmail.users.messages.trash({ userId: "me", id });
        const result = {
          action: "trash",
          messageId: response.data.id,
          threadId: response.data.threadId,
          labelIds: response.data.labelIds || [],
          messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
        };
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      }

      const addLabelIds: string[] = [];
      const removeLabelIds = remove_from_inbox ? ["INBOX"] : [];
      let destination: { id?: string; name?: string | null; created?: boolean } = {};

      if (!["archive", "archived"].includes(normalizedDestination)) {
        destination = await resolveOrCreateLabelId(gmail, destination_label, create_label_if_missing);
        if (destination.id) addLabelIds.push(destination.id);
      }

      const response = await gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: {
          addLabelIds,
          removeLabelIds: addLabelIds.includes("INBOX") ? removeLabelIds.filter((label) => label !== "INBOX") : removeLabelIds
        }
      });
      const result = {
        action: ["archive", "archived"].includes(normalizedDestination) ? "archive" : "move",
        destination,
        messageId: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds || [],
        messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_delete_message",
    {
      title: "Delete Gmail Message",
      description: "Move a Gmail message to Trash. This is recoverable from Gmail Trash and is not a permanent delete.",
      inputSchema: {
        message_id: z.string().min(1).describe("Gmail message id")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ message_id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.messages.trash({
        userId: "me",
        id: message_id.replace(/^message:/, "")
      });
      const result = {
        action: "trash",
        messageId: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds || [],
        messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_restore_message",
    {
      title: "Restore Gmail Message",
      description: "Remove a Gmail message from Trash.",
      inputSchema: {
        message_id: z.string().min(1).describe("Gmail message id")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ message_id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.messages.untrash({
        userId: "me",
        id: message_id.replace(/^message:/, "")
      });
      const result = {
        action: "untrash",
        messageId: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds || [],
        messageUrl: response.data.id ? gmailMessageUrl(response.data.id) : undefined
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_delete_thread",
    {
      title: "Delete Gmail Thread",
      description: "Move a full Gmail thread to Trash. This is recoverable from Gmail Trash and is not a permanent delete.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Gmail thread id")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ thread_id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.threads.trash({
        userId: "me",
        id: thread_id
      });
      const result = {
        action: "trash",
        threadId: response.data.id,
        messageIds: (response.data.messages || []).map((message: any) => message.id).filter(Boolean),
        snippet: response.data.snippet || ""
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_restore_thread",
    {
      title: "Restore Gmail Thread",
      description: "Remove a Gmail thread from Trash.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Gmail thread id")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ thread_id }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const response = await gmail.users.threads.untrash({
        userId: "me",
        id: thread_id
      });
      const result = {
        action: "untrash",
        threadId: response.data.id,
        messageIds: (response.data.messages || []).map((message: any) => message.id).filter(Boolean),
        snippet: response.data.snippet || ""
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_delete_label",
    {
      title: "Delete Gmail Label",
      description: "Delete a Gmail user label/folder. This removes the label but does not delete the messages that had it.",
      inputSchema: {
        label: z.string().min(1).describe("User label/folder name or id to delete")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ label }, extra) => {
      const gmail = await provider.gmailFor(gmailEmailFromAuth(extra.authInfo));
      const [resolved] = await resolveLabelIds(gmail, [label]);
      if (["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "IMPORTANT", "UNREAD", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"].includes(resolved.id)) {
        throw new Error(`Cannot delete Gmail system label: ${resolved.id}`);
      }
      await gmail.users.labels.delete({ userId: "me", id: resolved.id });
      const result = {
        action: "delete_label",
        deleted: resolved,
        note: "Messages that had this label were not deleted."
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_create_reminder",
    {
      title: "Create Gmail Reminder",
      description: "Create a custom Gmail reminder for a message or thread. This is not native Gmail Snooze: it labels the item, can hide it from Inbox now, and the server returns it to Inbox when due.",
      inputSchema: {
        message_id: z.string().min(1).optional().describe("Gmail message id. Provide either message_id or thread_id, not both."),
        thread_id: z.string().min(1).optional().describe("Gmail thread id. Provide either message_id or thread_id, not both."),
        remind_at: z.string().min(1).describe("Due time as ISO 8601 with timezone, for example 2026-05-15T09:00:00+02:00"),
        note: z.string().optional().describe("Optional note explaining why this reminder exists"),
        hide_until_due: z.boolean().default(true).describe("Remove INBOX now so the item behaves like a snoozed message"),
        return_to_inbox_when_due: z.boolean().default(true).describe("Add INBOX when the reminder becomes due"),
        mark_unread_when_due: z.boolean().default(true).describe("Add UNREAD when the reminder becomes due"),
        star_when_due: z.boolean().default(false).describe("Add STARRED when the reminder becomes due")
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async (input, extra) => {
      const hasMessage = typeof input.message_id === "string" && input.message_id.trim().length > 0;
      const hasThread = typeof input.thread_id === "string" && input.thread_id.trim().length > 0;
      if (hasMessage === hasThread) {
        throw new Error("Provide exactly one of message_id or thread_id.");
      }

      const { iso } = parseReminderTime(input.remind_at);
      const gmailEmail = gmailEmailFromAuth(extra.authInfo);
      const gmail = await provider.gmailFor(gmailEmail);
      const labels = await ensureReminderLabels(gmail);
      const targetType: ReminderTargetType = hasThread ? "thread" : "message";
      const targetId = hasThread ? normalizeGmailThreadId(input.thread_id || "") : normalizeGmailMessageId(input.message_id || "");

      const modified = await modifyGmailTargetLabels(
        gmail,
        targetType,
        targetId,
        [labels.base.id, labels.scheduled.id],
        input.hide_until_due ? ["INBOX"] : []
      );

      const reminder: StoredReminder = {
        id: randomUUID(),
        gmailEmail,
        targetType,
        targetId,
        remindAt: iso,
        note: input.note?.trim() || undefined,
        hideUntilDue: input.hide_until_due,
        returnToInboxWhenDue: input.return_to_inbox_when_due,
        markUnreadWhenDue: input.mark_unread_when_due,
        starWhenDue: input.star_when_due,
        status: "scheduled",
        createdAt: Date.now(),
        attempts: 0
      };

      const data = await store.all();
      data.reminders[reminder.id] = reminder;
      await store.save();

      const result = {
        reminder: publicReminder(reminder),
        labels: {
          base: labels.base,
          scheduled: labels.scheduled,
          due: labels.due
        },
        modified
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_list_reminders",
    {
      title: "List Gmail Reminders",
      description: "List custom Gmail reminders managed by this MCP server.",
      inputSchema: {
        status: z.enum(["scheduled", "completed", "cancelled", "all"]).default("scheduled"),
        max_results: z.number().int().min(1).max(100).default(20)
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
    },
    async ({ status, max_results }, extra) => {
      const gmailEmail = gmailEmailFromAuth(extra.authInfo);
      const data = await store.all();
      const reminders = Object.values(data.reminders)
        .filter((reminder) => reminder.gmailEmail === gmailEmail)
        .filter((reminder) => status === "all" || reminder.status === status)
        .sort((left, right) => new Date(left.remindAt).getTime() - new Date(right.remindAt).getTime())
        .slice(0, max_results)
        .map(publicReminder);

      return {
        structuredContent: { reminders },
        content: [{ type: "text", text: JSON.stringify({ reminders }) }]
      };
    }
  );

  server.registerTool(
    "gmail_cancel_reminder",
    {
      title: "Cancel Gmail Reminder",
      description: "Cancel a custom Gmail reminder. Optionally restore the item to Inbox while removing reminder labels.",
      inputSchema: {
        reminder_id: z.string().min(1),
        restore_to_inbox: z.boolean().default(false),
        remove_reminder_labels: z.boolean().default(true)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ reminder_id, restore_to_inbox, remove_reminder_labels }, extra) => {
      const gmailEmail = gmailEmailFromAuth(extra.authInfo);
      const data = await store.all();
      const reminder = data.reminders[reminder_id];
      if (!reminder || reminder.gmailEmail !== gmailEmail) {
        throw new Error(`Gmail reminder not found: ${reminder_id}`);
      }
      if (reminder.status !== "scheduled") {
        throw new Error(`Gmail reminder is already ${reminder.status}: ${reminder_id}`);
      }

      const gmail = await provider.gmailFor(gmailEmail);
      const labels = await ensureReminderLabels(gmail);
      const addLabelIds = restore_to_inbox ? ["INBOX"] : [];
      const removeLabelIds = remove_reminder_labels ? [labels.scheduled.id, labels.base.id] : [labels.scheduled.id];
      const modified = await modifyGmailTargetLabels(gmail, reminder.targetType, reminder.targetId, addLabelIds, removeLabelIds);

      data.reminders[reminder_id] = {
        ...reminder,
        status: "cancelled",
        cancelledAt: Date.now()
      };
      await store.save();

      const result = {
        reminder: publicReminder(data.reminders[reminder_id]),
        modified
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  server.registerTool(
    "gmail_process_due_reminders",
    {
      title: "Process Due Gmail Reminders",
      description: "Manually process due custom Gmail reminders for the connected account. The server also runs this automatically in the background.",
      inputSchema: {
        max_results: z.number().int().min(1).max(100).default(20)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    async ({ max_results }, extra) => {
      const gmailEmail = gmailEmailFromAuth(extra.authInfo);
      const results = await deliverDueReminders(provider, store, { gmailEmail, maxResults: max_results });
      return {
        structuredContent: { results },
        content: [{ type: "text", text: JSON.stringify({ results }) }]
      };
    }
  );

  server.registerTool(
    "apple_store_check_appointments",
    {
      title: "Check Apple Store Appointment Availability",
      description: "Check whether Saturday morning appointment slots are available at the configured Apple Store. Returns current availability data and upcoming Saturday slot status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
    },
    async (_input, _extra) => {
      if (!config.appleStore) {
        throw new Error("Apple Store checker is not enabled. Set APPLE_STORE_ENABLED=true and APPLE_STORE_NOTIFY_EMAIL in the server environment.");
      }
      const result = await checkAvailability(config.appleStore);
      const summary = [
        `Store: ${result.storeName} (${result.storeId})`,
        `Checked at: ${result.checkedAt}`,
        `Currently available: ${result.currentlyAvailable}`,
        `Is Saturday morning now: ${result.isSaturdayMorningNow}`,
        `Next Saturday: ${result.saturdayDate}`,
        `Advance Saturday slots found: ${result.saturdayAdvanceSlotUtcHours.length > 0 ? result.saturdayAdvanceSlotUtcHours.join(", ") + " (UTC)" : "none yet"}`
      ].join("\n");
      return {
        structuredContent: result,
        content: [{ type: "text", text: summary }]
      };
    }
  );

  return server;
}

async function main() {
  const config = loadConfig();
  const store = new JsonStore(config.storePath);
  await store.all();
  const provider = new GmailOAuthProvider(config, store);

  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  app.set("trust proxy", "loopback");
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.type("text/plain").send("Gmail ChatGPT MCP server is running. Use /mcp as the connector URL.");
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/oauth/google/callback", async (req, res, next) => {
    try {
      await provider.handleGoogleCallback(req.query, res);
    } catch (error) {
      next(error);
    }
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.publicBaseUrl),
    baseUrl: new URL(config.publicBaseUrl),
    resourceServerUrl: config.resourceUrl,
    scopesSupported: config.mcpScopes,
    resourceName: "Gmail MCP"
  }));

  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["gmail.read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl)
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport: StreamableHTTPServerTransport | undefined;

      if (typeof sessionId === "string" && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport as StreamableHTTPServerTransport;
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) delete transports[closedSessionId];
        };
        await createServer(provider, store, config).connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid MCP session" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session id");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session id");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(config.port, config.host, () => {
    console.log(`Gmail MCP server listening on http://${config.host}:${config.port}`);
    console.log(`Public resource URL: ${config.resourceUrl.href}`);
    console.log(`Google redirect URI: ${config.googleRedirectUri}`);
  });

  startReminderScheduler(provider, store, config.reminderCheckIntervalSeconds);

  if (config.appleStore) {
    const appleStoreConfig = config.appleStore;
    startAppleStoreChecker(appleStoreConfig, async (subject, body) => {
      if (config.telegram) {
        await sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, `<b>${subject}</b>\n\n${body}`);
      } else {
        const gmail = await provider.gmailFor(appleStoreConfig.notifyEmail);
        await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: buildMessageRaw({ to: appleStoreConfig.notifyEmail, subject, body })
          }
        });
      }
    });
    console.log(`Apple Store checker started for ${appleStoreConfig.storeName} (${appleStoreConfig.storeId})`);
    console.log(`Notification email: ${appleStoreConfig.notifyEmail}`);

    if (config.telegram) {
      const recapHour = Number(process.env.TELEGRAM_RECAP_HOUR ?? 9);
      startDailyRecap(config.telegram, appleStoreConfig, recapHour);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
