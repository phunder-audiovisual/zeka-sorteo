
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";
const ADMIN_UID = "GJe2WMAvJsdLtaaqfYT38fjJOVh1";

async function getGoogleAccessToken() {
  const {
    GCP_PROJECT_NUMBER,
    GCP_SERVICE_ACCOUNT_EMAIL,
    GCP_WORKLOAD_IDENTITY_POOL_ID,
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  } = process.env;

  if (!PROJECT_ID || !GCP_PROJECT_NUMBER ||
      !GCP_SERVICE_ACCOUNT_EMAIL ||
      !GCP_WORKLOAD_IDENTITY_POOL_ID ||
      !GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID) {
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

  if (!client) throw new Error("Error creando cliente Google.");

  const result = await client.getAccessToken();
  if (!result.token) throw new Error("No se obtuvo token Google.");

  return result.token;
}

async function firestoreRequest(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Firestore:", text);
    throw new Error("Error consultando Firestore.");
  }

  return text ? JSON.parse(text) : {};
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!idToken) {
      return res.status(401).json({ error: "Falta iniciar sesión." });
    }

    const { getAuth } = require("firebase-admin/auth");
const { initializeApp, getApps } =
  require("firebase-admin/app");

    const app = getApps().length
      ? getApps()[0]
      : initializeApp({
    projectId: PROJECT_ID
  });

    const decoded = await getAuth(app).verifyIdToken(idToken);
    if (decoded.uid !== ADMIN_UID) {
      return res.status(403).json({ error: "No autorizado." });
    }

    const token = await getGoogleAccessToken();

    const base =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/databases/(default)/documents`;

    const raffleUrl = `${base}/raffles/${RAFFLE_ID}`;

    const raffle = await fetch(raffleUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!raffle.ok) {
      throw new Error("No se pudo consultar el sorteo.");
    }

    const raffleDoc = await raffle.json();

    if (raffleDoc.fields?.status?.stringValue !== "open") {
      return res.status(409).json({ error: "El sorteo ya no está abierto." });
    }

    const reservations = await fetch(
      `${base}:runQuery`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "reservations" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "raffleId" },
                op: "EQUAL",
                value: { stringValue: RAFFLE_ID }
              }
            }
          }
        })
      }
    );

    if (!reservations.ok) {
      throw new Error("No se pudieron consultar las reservas.");
    }

    const rows = await reservations.json();

    const pending = rows
      .map(row => row.document)
      .filter(doc =>
        doc?.fields?.status?.stringValue === "pending"
      );

    if (pending.length) {
      return res.status(409).json({
        error: "Hay pagos o reservas pendientes. Resolvelos antes de cerrar.",
        pending: pending.length
      });
    }

    const closeResponse = await firestoreRequest(
      `${base}:commit`,
      token,
      {
        writes: [{
          update: {
            name: raffleDoc.name,
            fields: {
              status: { stringValue: "closed" },
              closedAt: { timestampValue: new Date().toISOString() }
            }
          },
          updateMask: {
            fieldPaths: ["status", "closedAt"]
          },
          currentDocument: {
            updateTime: raffleDoc.updateTime
          }
        }]
      }
    );

    return res.status(200).json({
      success: true,
      message: "Venta cerrada correctamente."
    });

  } catch (error) {
    console.error("Error cerrando sorteo:", error);
    return res.status(500).json({
      error: "No se pudo cerrar la venta."
    });
  }
};
