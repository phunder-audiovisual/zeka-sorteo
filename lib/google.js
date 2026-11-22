"use strict";

// Utilidades compartidas por todas las funciones de /api.
// Este archivo vive fuera de /api a propósito: así Vercel no lo publica
// como una función más.

const ADMIN_UID = process.env.ADMIN_UID || "GJe2WMAvJsdLtaaqfYT38fjJOVh1";
const PROJECT_ID = process.env.GCP_PROJECT_ID || "zeka-sorteo";

// Nombre de recurso de Firestore (el que usan los campos "name" de los
// documentos) y URL base de la API REST.
const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`;
const ROOT = `https://firestore.googleapis.com/v1/${DOCS}`;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Lectura de campos de Firestore (formato REST) ----------

function getString(fields, name) {
  return fields?.[name]?.stringValue || "";
}

function getNumber(fields, name) {
  const field = fields?.[name];
  if (!field) return null;

  const value = Number(field.integerValue ?? field.doubleValue);
  return Number.isFinite(value) ? value : null;
}

function getTimestamp(fields, name) {
  return fields?.[name]?.timestampValue || null;
}

// ---------- Autenticación con Google Cloud (sin claves en el repo) ----------

async function getGoogleAccessToken() {
  const {
    GCP_PROJECT_NUMBER,
    GCP_SERVICE_ACCOUNT_EMAIL,
    GCP_WORKLOAD_IDENTITY_POOL_ID,
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  } = process.env;

  if (
    !process.env.GCP_PROJECT_ID ||
    !GCP_PROJECT_NUMBER ||
    !GCP_SERVICE_ACCOUNT_EMAIL ||
    !GCP_WORKLOAD_IDENTITY_POOL_ID ||
    !GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  ) {
    throw new Error("Faltan variables de Google Cloud.");
  }

  const { getVercelOidcToken } = await import("@vercel/oidc");
  const { ExternalAccountClient } = require("google-auth-library");

  const audience =
    `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}` +
    `/locations/global/workloadIdentityPools/` +
    `${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/` +
    `${GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`;

  const client = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
      `${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: async () => await getVercelOidcToken()
    }
  });

  if (!client) {
    throw new Error("No se pudo crear el cliente de Google.");
  }

  const result = await client.getAccessToken();

  if (!result.token) {
    throw new Error("Google no devolvió un token.");
  }

  return result.token;
}

// ---------- Identidad de quien llama a la API ----------

function readBearerToken(req) {
  const header = req.headers?.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Devuelve el uid de Firebase dueño del token, o null si el token no sirve.
async function lookupUser(idToken) {
  if (!idToken) return null;

  if (!process.env.FIREBASE_API_KEY) {
    throw new Error("Falta FIREBASE_API_KEY.");
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

    if (!response.ok) {
    // Deja el motivo en los Logs de Vercel (nunca incluye la clave).
    const detail = await response.text().catch(() => "");
    console.error(
      "lookupUser: Firebase rechazó el token.",
      response.status,
      detail.slice(0, 400)
    );
    return null;
  }

  const data = await response.json();
  const uid = data.users?.[0]?.localId || null;

  if (!uid) {
    console.error("lookupUser: la respuesta no trae usuario.");
  }

  return uid;
}

async function verifyAdmin(req) {
  const idToken = readBearerToken(req);

  if (!idToken) return { valid: false, status: 401 };

  const uid = await lookupUser(idToken);

  if (!uid) return { valid: false, status: 401 };
  if (uid !== ADMIN_UID) return { valid: false, status: 403 };

  return { valid: true, uid };
}

// ---------- Firestore REST ----------

function parseJsonLoose(text) {
  const value = text.trim();

  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    // Algunas respuestas llegan como una línea JSON por documento.
    return value
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}

async function firestoreRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Firestore:", response.status, text.slice(0, 600));

    let message = "Error consultando Firestore.";

    try {
      message = JSON.parse(text).error?.message || message;
    } catch {
      // Se mantiene el mensaje genérico.
    }

    const error = new HttpError(response.status, message);
    // Marca los errores de Firestore para no mostrarlos a los clientes.
    error.internal = true;
    throw error;
  }

  return parseJsonLoose(text);
}

module.exports = {
  ADMIN_UID,
  PROJECT_ID,
  DOCS,
  ROOT,
  ID_PATTERN,
  HttpError,
  getString,
  getNumber,
  getTimestamp,
  getGoogleAccessToken,
  readBearerToken,
  lookupUser,
  verifyAdmin,
  firestoreRequest
};
