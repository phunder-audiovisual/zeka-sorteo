
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

  if (
    !PROJECT_ID ||
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

  if (!client) throw new Error("Error creando cliente Google.");

  const result = await client.getAccessToken();

  if (!result.token) {
    throw new Error("No se obtuvo token Google.");
  }

  return result.token;
}

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!idToken || !process.env.FIREBASE_API_KEY) {
    return false;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) return false;

  const data = await response.json();

  return data.users?.[0]?.localId === ADMIN_UID;
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
    console.error("Firestore:", text);
    throw new Error("Error consultando Firestore.");
  }

  return text ? JSON.parse(text) : {};
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido."
    });
  }

  try {
    if (!PROJECT_ID) {
      throw new Error("Falta GCP_PROJECT_ID.");
    }

    if (!(await verifyAdmin(req))) {
      return res.status(403).json({
        error: "No estás autorizado para cerrar la venta."
      });
    }

    const token = await getGoogleAccessToken();

    const base =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/databases/(default)/documents`;

    const raffleUrl = `${base}/raffles/${RAFFLE_ID}`;

    const raffleDoc = await firestoreRequest(
      raffleUrl,
      token
    );

    if (raffleDoc.fields?.status?.stringValue !== "open") {
      return res.status(409).json({
        error: "La venta ya está cerrada o el sorteo ya fue realizado."
      });
    }

    // Revisar únicamente reservas que todavía están vigentes.
    const rows = await firestoreRequest(
      `${base}:runQuery`,
      token,
      {
        method: "POST",
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

    const now = Date.now();

    const activePending = rows
      .map(row => row.document)
      .filter(doc => {
        if (
          doc?.fields?.status?.stringValue !== "pending"
        ) {
          return false;
        }

        const expiry =
          doc.fields.expiresAt?.timestampValue;

        return expiry && Date.parse(expiry) > now;
      });

    if (activePending.length > 0) {
      return res.status(409).json({
        error: "Hay reservas todavía vigentes. Esperá a que se resuelvan antes de cerrar.",
        pending: activePending.length
      });
    }

    // Cerrar conservando control de concurrencia.
    await firestoreRequest(
      `${base}:commit`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          writes: [{
            update: {
              name: raffleDoc.name,
              fields: {
                status: { stringValue: "closed" },
                closedAt: {
                  timestampValue: new Date().toISOString()
                }
              }
            },
            updateMask: {
              fieldPaths: ["status", "closedAt"]
            },
            currentDocument: {
              updateTime: raffleDoc.updateTime
            }
          }]
        })
      }
    );

    return res.status(200).json({
      success: true,
      message: "Venta cerrada correctamente."
    });

  } catch (error) {
    console.error("Error cerrando sorteo:", error);

    return res.status(500).json({
      error: error.message || "No se pudo cerrar la venta."
    });
  }
};
