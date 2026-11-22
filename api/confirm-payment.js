"use strict";

const {
  verifyAdmin,
  getGoogleAccessToken
} = require("../lib/google");

const { processReservation } = require("../lib/payments");

// Confirma a mano el pago de una transferencia (solo administrador).

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
          ? "No estás autorizado."
          : "Debés iniciar sesión como administrador."
      });
    }

    const reservationId = req.body?.reservationId;

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(400).json({
        error: "Identificador de reserva inválido."
      });
    }

    const token = await getGoogleAccessToken();

    const result = await processReservation(token, {
      reservationId,
      manual: true
    });

    if (result.success || result.alreadyPaid) {
      return res.status(200).json({
        success: true,
        alreadyPaid: Boolean(result.alreadyPaid)
      });
    }

    return res.status(409).json({
      error: result.reason || "No se pudo confirmar el pago."
    });
  } catch (error) {
    console.error("Error confirm-payment:", error);

    return res.status(500).json({
      error: "No se pudo confirmar el pago."
    });
  }
};
