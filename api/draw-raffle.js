
const crypto = require("crypto");

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";
const ADMIN_UID = "GJe2WMAvJsdLtaaqfYT38fjJOVh1";

const ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function send(res, status, data) {
  return res.status(status).json(data);
}

function getString(fields, name) {
  return fields?.[name]?.stringValue || "";
}

function getNumber(fields, name) {
  const value = fields?.[name];
  return Number(value?.integerValue ?? value?.doubleValue ?? 0);
}

function getTimestamp(fields, name) {
  return fields?.[name]?.timestampValue || null;
}

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

  if (!client) {
    throw new Error("No se pudo crear el cliente de Google.");
  }

  const result = await client.getAccessToken();

  if (!result.token) {
    throw new Error("Google no devolvió un token.");
  }

  return result.token;
}

async function verifyAdmin(req) {
  const authorization = req.headers.authorization || "";
  const idToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!idToken) {
    return { valid: false, status: 401 };
  }

  if (!process.env.FIREBASE_API_KEY) {
    throw new Error("Falta FIREBASE_API_KEY.");
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

  if (!response.ok) {
    return { valid: false, status: 401 };
  }

  const data = await response.json();

  if (data.users?.[0]?.localId !== ADMIN_UID) {
    return { valid: false, status: 403 };
  }

  return { valid: true };
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

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Firestore:", data);
    throw new Error(
      data.error?.message || "Error consultando Firestore."
    );
  }

  return data;
}

async function runQuery(
  parent,
  collectionId,
  filters,
  token,
  transaction
) {
  const result = await firestoreRequest(
    `${ROOT}:runQuery`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        parent,
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            compositeFilter: {
              op: "AND",
              filters
            }
          }
        },
        transaction
      })
    }
  );

  return result
    .filter(item => item.document)
    .map(item => item.document);
}

function randomWinners(tickets, count) {
  const available = [...tickets];
  const winners = [];

  for (let i = 0; i < count; i++) {
    const index = crypto.randomInt(available.length);
    winners.push(available.splice(index, 1)[0]);
  }

  return winners;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return send(res, 405, {
      error: "Método no permitido."
    });
  }

  if (!PROJECT_ID) {
    return send(res, 500, {
      error: "Falta GCP_PROJECT_ID en Vercel."
    });
  }

  let transaction;

  try {
    // Verificar identidad del administrador.
    const admin = await verifyAdmin(req);

    if (!admin.valid) {
      return send(res, admin.status, {
        error: admin.status === 403
          ? "No estás autorizado para realizar el sorteo."
          : "Debés iniciar sesión como administrador."
      });
    }

    const raffleId = req.body?.raffleId || RAFFLE_ID;

    if (raffleId !== RAFFLE_ID) {
      return send(res, 400, {
        error: "ID de sorteo no válido."
      });
    }

    // Obtener credenciales de Google Cloud.
    const token = await getGoogleAccessToken();

    // Iniciar transacción.
    const started = await firestoreRequest(
      `${ROOT}:beginTransaction`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          options: { readWrite: {} }
        })
      }
    );

    transaction = started.transaction;

    if (!transaction) {
      throw new Error("No se pudo iniciar la transacción.");
    }

    // Leer el sorteo.
    const raffleDocument = await firestoreRequest(
      `${ROOT}/raffles/${raffleId}?transaction=${encodeURIComponent(transaction)}`,
      token
    );

    const raffleFields = raffleDocument.fields || {};
    const raffleStatus = getString(raffleFields, "status");

    if (raffleStatus === "drawn") {
      throw new Error("Este sorteo ya fue realizado.");
    }

    if (raffleStatus !== "closed") {
      throw new Error(
        "Primero tenés que cerrar la venta desde el administrador."
      );
    }

    const winnerCount = getNumber(raffleFields, "winners");

    if (
      !Number.isInteger(winnerCount) ||
      winnerCount < 1 ||
      winnerCount > 3
    ) {
      throw new Error("La cantidad de ganadores no es válida.");
    }

    // Consultar reservas pendientes.
    const pendingReservations = await runQuery(
      ROOT,
      "reservations",
      [
        {
          fieldFilter: {
            field: { fieldPath: "raffleId" },
            op: "EQUAL",
            value: { stringValue: raffleId }
          }
        },
        {
          fieldFilter: {
            field: { fieldPath: "status" },
            op: "EQUAL",
            value: { stringValue: "pending" }
          }
        }
      ],
      token,
      transaction
    );

    const now = Date.now();

    // Solo bloquear reservas que todavía están vigentes.
    const activeReservations = pendingReservations.filter(doc => {
      const expiry = getTimestamp(doc.fields, "expiresAt");

      return expiry && Date.parse(expiry) > now;
    });

    if (activeReservations.length > 0) {
      throw new Error(
        `Hay ${activeReservations.length} reservas todavía vigentes. Esperá a que se resuelvan antes del sorteo.`
      );
    }

    // Consultar exclusivamente números pagados.
    const paidTickets = await runQuery(
      `${ROOT}/raffles/${raffleId}`,
      "tickets",
      [
        {
          fieldFilter: {
            field: { fieldPath: "status" },
            op: "EQUAL",
            value: { stringValue: "paid" }
          }
        }
      ],
      token,
      transaction
    );

    const eligibleTickets = paidTickets
      .filter(doc => doc.fields?.paid?.booleanValue === true)
      .map(doc => ({
        number: doc.name.split("/").pop(),
        name: getString(doc.fields, "participantName").trim()
      }))
      .filter(ticket =>
        /^\d{3}$/.test(ticket.number) &&
        ticket.name.length > 0
      );

    if (eligibleTickets.length < winnerCount) {
      throw new Error(
        `Se necesitan ${winnerCount} números pagados con participante registrado. Actualmente hay ${eligibleTickets.length}.`
      );
    }

    // Selección aleatoria segura en el servidor.
    const selected = randomWinners(
      eligibleTickets,
      winnerCount
    );

    const winnerValues = selected.map(winner => ({
      mapValue: {
        fields: {
          number: { stringValue: winner.number },
          name: { stringValue: winner.name }
        }
      }
    }));

    // Guardar el resultado definitivamente.
    await firestoreRequest(
      `${ROOT}:commit`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          transaction,
          writes: [
            {
              update: {
                name: `${ROOT}/raffles/${raffleId}`,
                fields: {
                  status: { stringValue: "drawn" },
                  drawResults: {
                    arrayValue: {
                      values: winnerValues
                    }
                  },
                  drawnAt: {
                    timestampValue: new Date().toISOString()
                  }
                }
              },
              updateMask: {
                fieldPaths: [
                  "status",
                  "drawResults",
                  "drawnAt"
                ]
              }
            }
          ]
        })
      }
    );

    transaction = null;

    return send(res, 200, {
      success: true,
      message: "Sorteo realizado correctamente.",
      winners: selected
    });

  } catch (error) {
    console.error("Error realizando sorteo:", error);

    if (transaction) {
      try {
        const token = await getGoogleAccessToken();

        await firestoreRequest(
          `${ROOT}:rollback`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ transaction })
          }
        );
      } catch (rollbackError) {
        console.error("Error cerrando transacción:", rollbackError);
      }
    }

    return send(res, 400, {
      error: error.message || "No se pudo realizar el sorteo."
    });
  }
};
    
