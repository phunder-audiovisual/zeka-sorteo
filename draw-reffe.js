
const crypto = require("crypto");

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

async function verifyAdmin(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) return false;

  const data = await response.json();
  return data.users?.[0]?.localId === ADMIN_UID;
}

async function firestoreGet(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) throw new Error("Error leyendo Firestore.");
  return response.json();
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

    if (!idToken || !(await verifyAdmin(idToken))) {
      return res.status(403).json({ error: "No autorizado." });
    }

    const token = await getGoogleAccessToken();

    const base =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/databases/(default)/documents`;

    const raffleUrl = `${base}/raffles/${RAFFLE_ID}`;
    const raffle = await firestoreGet(raffleUrl, token);

    if (raffle.fields?.status?.stringValue !== "closed") {
      return res.status(409).json({
        error: "Primero tenés que cerrar la venta."
      });
    }

    if (raffle.fields?.drawResults?.arrayValue?.values?.length) {
      return res.status(409).json({
        error: "El sorteo ya tiene ganadores."
      });
    }

    const response = await fetch(
      `${base}/raffles/${RAFFLE_ID}:runQuery`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "tickets" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "paid" },
                op: "EQUAL",
                value: { booleanValue: true }
              }
            }
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error("No se pudieron consultar los números pagados.");
    }

    const rows = await response.json();

    const tickets = rows
      .map(row => row.document)
      .filter(doc =>
        doc &&
        doc.fields?.status?.stringValue === "paid" &&
        doc.fields?.paid?.booleanValue === true &&
        doc.fields?.reservationId?.stringValue
      );

    if (tickets.length < 2) {
      return res.status(409).json({
        error: "Se necesitan al menos dos números pagados."
      });
    }

    const selected = [];
    const available = [...tickets];

    while (selected.length < 2) {
      const index = crypto.randomInt(available.length);
      selected.push(available.splice(index, 1)[0]);
    }

    const winners = [];

    for (const ticket of selected) {
      const reservationId =
        ticket.fields.reservationId.stringValue;

      const reservation = await firestoreGet(
        `${base}/reservations/${encodeURIComponent(reservationId)}`,
        token
      );

      const name = reservation.fields?.name?.stringValue;

      if (!name ||
          reservation.fields?.status?.stringValue !== "paid") {
        throw new Error("No se pudo verificar un participante ganador.");
      }

      const number = ticket.name.split("/").pop();

      winners.push({
        mapValue: {
          fields: {
            number: { stringValue: number },
            name: { stringValue: name }
          }
        }
      });
    }

    const commit = await fetch(`${base}:commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        writes: [{
          update: {
            name: raffle.name,
            fields: {
              status: { stringValue: "drawn" },
              drawResults: {
                arrayValue: { values: winners }
              },
              drawnAt: {
                timestampValue: new Date().toISOString()
              }
            }
          },
          updateMask: {
            fieldPaths: ["status", "drawResults", "drawnAt"]
          },
          currentDocument: {
            updateTime: raffle.updateTime
          }
        }]
      })
    });

    if (!commit.ok) {
      throw new Error("No se pudieron guardar los ganadores.");
    }

    return res.status(200).json({
      success: true,
      message: "Sorteo realizado.",
      winners: winners.map(item => ({
        number: item.mapValue.fields.number.stringValue,
        name: item.mapValue.fields.name.stringValue
      }))
    });

  } catch (error) {
    console.error("Error en sorteo:", error);
    return res.status(500).json({
      error: "No se pudo realizar el sorteo."
    });
  }
};
