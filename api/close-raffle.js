"use strict";

const {
  DOCS,
  ROOT,
  ID_PATTERN,
  HttpError,
  getString,
  verifyAdmin,
  getGoogleAccessToken,
  firestoreRequest
} = require("../lib/google");

// Cierra la venta de un sorteo (solo administrador). Las reservas
// anteriores al cierre todavía pueden completar su pago.

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const admin = await verifyAdmin(req);

    if (!admin.valid) {
      return res.status(admin.status).json({
        error: admin.status === 403
          ? "No estás autorizado para cerrar la venta."
          : "Debés iniciar sesión como administrador."
      });
    }

    const raffleId = req.body?.raffleId;

    if (typeof raffleId !== "string" || !ID_PATTERN.test(raffleId)) {
      return res.status(400).json({ error: "ID de sorteo no válido." });
    }

    const token = await getGoogleAccessToken();

    let raffle;

    try {
      raffle = await firestoreRequest(`${ROOT}/raffles/${raffleId}`, token);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return res.status(404).json({ error: "No se encontró el sorteo." });
      }
      throw error;
    }

    if (getString(raffle.fields, "status") !== "open") {
      return res.status(409).json({
        error: "La venta ya está cerrada o el sorteo ya fue realizado."
      });
    }

    await firestoreRequest(`${ROOT}:commit`, token, {
      method: "POST",
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: `${DOCS}/raffles/${raffleId}`,
              fields: {
                status: { stringValue: "closed" },
                closedAt: { timestampValue: new Date().toISOString() }
              }
            },
            updateMask: { fieldPaths: ["status", "closedAt"] },
            currentDocument: { updateTime: raffle.updateTime }
          }
        ]
      })
    });

    return res.status(200).json({
      success: true,
      message: "Venta cerrada correctamente."
    });
  } catch (error) {
    console.error("Error cerrando sorteo:", error);

    return res.status(500).json({ error: "No se pudo cerrar la venta." });
  }
};
