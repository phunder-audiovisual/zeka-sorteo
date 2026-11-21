
import crypto from "node:crypto";

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";

const DATABASE = `(default)`;
const ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE}/documents`;

function response(res, status, data) {
  return res.status(status).json(data);
}

function getString(fields, name) {
  return fields?.[name]?.stringValue || "";
}

function getNumber(fields, name) {
  return Number(fields?.[name]?.integerValue || 0);
}

function getTimestamp(fields, name) {
  return fields?.[name]?.timestampValue || null;
}

function decodeDocument(document) {
  return document?.fields || {};
}

async function firestoreRequest(url, token, options = {}) {
  const result = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await result.json().catch(() => ({}));

  if (!result.ok) {
    throw new Error(
      data.error?.message || "Error consultando Firestore."
    );
  }

  return data;
}

async function runQuery(parent, collectionId, filters, token, transaction) {
  const url = `${ROOT}:runQuery`;

  const body = {
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
  };

  const result = await firestoreRequest(url, token, {
    method: "POST",
    body: JSON.stringify(body)
  });

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return response(res, 405, {
      error: "Método no permitido."
    });
  }

  if (!PROJECT_ID) {
    return response(res, 500, {
      error: "Falta GCP_PROJECT_ID en Vercel."
    });
  }

  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return response(res, 401, {
      error: "Debés iniciar sesión como administrador."
    });
  }

  const raffleId = req.body?.raffleId || RAFFLE_ID;

  if (raffleId !== RAFFLE_ID) {
    return response(res, 400, {
      error: "ID de sorteo no válido."
    });
  }

  let transaction;

  try {
    // Iniciar transacción segura de Firestore.
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

    // Leer el sorteo dentro de la transacción.
    const raffleDocument = await firestoreRequest(
      `${ROOT}/raffles/${raffleId}?transaction=${encodeURIComponent(transaction)}`,
      token
    );

    const raffleFields = decodeDocument(raffleDocument);

    if (getString(raffleFields, "status") !== "open") {
      throw new Error("El sorteo no está abierto o ya fue cerrado.");
    }

    const winnerCount = getNumber(raffleFields, "winners");

    if (!Number.isInteger(winnerCount) || winnerCount < 1) {
      throw new Error("Cantidad de ganadores inválida.");
    }

    // Comprobar reservas que todavía no vencieron.
    const pendingReservations = await runQuery(
      `${ROOT}`,
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

    const activeReservations = pendingReservations.filter(doc => {
      const expiry = getTimestamp(doc.fields, "expiresAt");
      return expiry && new Date(expiry).getTime() > now;
    });

    if (pendingReservations.length > 0) {
      throw new Error(
        "Hay reservas pendientes. Confirmá o rechazá esos pagos antes del sorteo."
      );
    }

    // Buscar exclusivamente números con pago confirmado.
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
        name: getString(doc.fields, "participantName")
      }))
      .filter(ticket => ticket.name.trim() !== "");

    if (eligibleTickets.length < winnerCount) {
      throw new Error(
        `Se necesitan ${winnerCount} números pagados con participante registrado.`
      );
    }

    // Elegir ganadores aleatoriamente en el servidor.
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

    // Guardar el resultado y cerrar el sorteo en una operación.
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

    return response(res, 200, {
      success: true,
      message: "Sorteo realizado correctamente.",
      winners: selected
    });

  } catch (error) {
    console.error("Error realizando sorteo:", error);

    if (transaction) {
      try {
        await firestoreRequest(
          `${ROOT}:rollback`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ transaction })
          }
        );
      } catch (_) {}
    }

    return response(res, 400, {
      error: error.message || "No se pudo realizar el sorteo."
    });
  }
}
