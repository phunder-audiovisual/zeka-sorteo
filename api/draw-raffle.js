"use strict";

const crypto = require("crypto");

const {
  DOCS,
  ROOT,
  ID_PATTERN,
  getString,
  getNumber,
  getTimestamp,
  verifyAdmin,
  getGoogleAccessToken,
  firestoreRequest
} = require("../lib/google");

// Realiza el sorteo (solo administrador). Elige al azar, en el servidor,
// entre los números pagados con participante registrado.

class DrawError extends Error {}

async function runQuery(parentUrl, collectionId, filters, token, transaction) {
  const result = await firestoreRequest(`${parentUrl}:runQuery`, token, {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          compositeFilter: { op: "AND", filters }
        }
      },
      transaction
    })
  });

  return (Array.isArray(result) ? result : [result])
    .filter(item => item.document)
    .map(item => item.document);
}

function equalFilter(fieldPath, value) {
  return {
    fieldFilter: {
      field: { fieldPath },
      op: "EQUAL",
      value
    }
  };
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
    return res.status(405).json({ error: "Método no permitido." });
  }

  let token = null;
  let transaction = null;

  try {
    const admin = await verifyAdmin(req);

    if (!admin.valid) {
      return res.status(admin.status).json({
        error: admin.status === 403
          ? "No estás autorizado para realizar el sorteo."
          : "Debés iniciar sesión como administrador."
      });
    }

    const raffleId = req.body?.raffleId;

    if (typeof raffleId !== "string" || !ID_PATTERN.test(raffleId)) {
      return res.status(400).json({ error: "ID de sorteo no válido." });
    }

    token = await getGoogleAccessToken();

    const started = await firestoreRequest(
      `${ROOT}:beginTransaction`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ options: { readWrite: {} } })
      }
    );

    transaction = started.transaction;

    if (!transaction) {
      throw new Error("No se pudo iniciar la transacción.");
    }

    const raffleUrl = `${ROOT}/raffles/${raffleId}`;

    const raffleDocument = await firestoreRequest(
      `${raffleUrl}?transaction=${encodeURIComponent(transaction)}`,
      token
    );

    const raffleFields = raffleDocument.fields || {};
    const raffleStatus = getString(raffleFields, "status");

    if (raffleStatus === "drawn") {
      throw new DrawError("Este sorteo ya fue realizado.");
    }

    if (raffleStatus !== "closed") {
      throw new DrawError(
        "Primero tenés que cerrar la venta desde el administrador."
      );
    }

    const winnerCount = getNumber(raffleFields, "winners");

    if (![1, 2, 3].includes(winnerCount)) {
      throw new DrawError(
        "La cantidad de ganadores del sorteo no es válida."
      );
    }

    // Las reservas vigentes todavía pueden pagarse: hay que esperarlas.
    const pendingReservations = await runQuery(
      ROOT,
      "reservations",
      [
        equalFilter("raffleId", { stringValue: raffleId }),
        equalFilter("status", { stringValue: "pending" })
      ],
      token,
      transaction
    );

    const now = Date.now();

    const activeReservations = pendingReservations.filter(document => {
      const expiry = getTimestamp(document.fields, "expiresAt");
      return expiry && Date.parse(expiry) > now;
    });

    if (activeReservations.length > 0) {
      throw new DrawError(
        `Hay ${activeReservations.length} reservas todavía vigentes. Esperá a que se resuelvan o confirmá sus pagos antes del sorteo.`
      );
    }

    // Solo participan los números pagados.
    const paidTickets = await runQuery(
      raffleUrl,
      "tickets",
      [equalFilter("status", { stringValue: "paid" })],
      token,
      transaction
    );

    const eligibleTickets = paidTickets
      .filter(document => document.fields?.paid?.booleanValue === true)
      .map(document => ({
        number: document.name.split("/").pop(),
        name: getString(document.fields, "participantName").trim()
      }))
      .filter(
        ticket => /^\d{3}$/.test(ticket.number) && ticket.name.length > 0
      );

    if (eligibleTickets.length < winnerCount) {
      throw new DrawError(
        `Se necesitan ${winnerCount} números pagados con participante registrado. Actualmente hay ${eligibleTickets.length}.`
      );
    }

    const selected = randomWinners(eligibleTickets, winnerCount);

    const winnerValues = selected.map(winner => ({
      mapValue: {
        fields: {
          number: { stringValue: winner.number },
          name: { stringValue: winner.name }
        }
      }
    }));

    await firestoreRequest(`${ROOT}:commit`, token, {
      method: "POST",
      body: JSON.stringify({
        transaction,
        writes: [
          {
            update: {
              name: `${DOCS}/raffles/${raffleId}`,
              fields: {
                status: { stringValue: "drawn" },
                drawResults: { arrayValue: { values: winnerValues } },
                drawnAt: { timestampValue: new Date().toISOString() }
              }
            },
            updateMask: {
              fieldPaths: ["status", "drawResults", "drawnAt"]
            }
          }
        ]
      })
    });

    transaction = null;

    return res.status(200).json({
      success: true,
      message: "Sorteo realizado correctamente.",
      winners: selected
    });
  } catch (error) {
    console.error("Error realizando sorteo:", error);

    if (transaction && token) {
      try {
        await firestoreRequest(`${ROOT}:rollback`, token, {
          method: "POST",
          body: JSON.stringify({ transaction })
        });
      } catch (rollbackError) {
        console.error("Error cerrando transacción:", rollbackError);
      }
    }

    if (error instanceof DrawError) {
      return res.status(409).json({ error: error.message });
    }

    return res.status(500).json({
      error: "No se pudo realizar el sorteo. Intentá de nuevo."
    });
  }
};
