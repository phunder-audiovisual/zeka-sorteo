"use strict";

const {
  HttpError,
  readBearerToken,
  lookupUser,
  getGoogleAccessToken
} = require("../lib/google");

const { loadHeldReservation, extendHold } = require("../lib/payments");

// Medios que se pagan por transferencia y confirma el administrador.
const MANUAL_METHODS = ["naranjax", "cuentadni"];

// Tiempo extra para que el administrador verifique la transferencia.
const REPORTED_HOLD_MINUTES = 180;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const idToken = readBearerToken(req);

    if (!idToken) {
      return res.status(401).json({ error: "Tenés que iniciar sesión." });
    }

    const reservationId = req.body?.reservationId;
    const method = req.body?.method;

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(400).json({
        error: "Identificador de reserva inválido."
      });
    }

    if (!MANUAL_METHODS.includes(method)) {
      return res.status(400).json({ error: "Medio de pago no válido." });
    }

    const uid = await lookupUser(idToken);

    if (!uid) {
      return res.status(401).json({ error: "Tenés que iniciar sesión." });
    }

    const googleToken = await getGoogleAccessToken();

    // Se acepta aunque el contador haya vencido, mientras los números
    // todavía sigan reservados para esta persona.
    const held = await loadHeldReservation(googleToken, reservationId, {
      expectedUid: uid,
      allowExpired: true
    });

    const now = new Date();

    const extra = {
      paymentMethod: { stringValue: method },
      paymentReported: { booleanValue: true },
      paymentReportedAt: { timestampValue: now.toISOString() }
    };

    // Solo la primera vez se alarga la reserva, para que nadie pueda
    // retener números indefinidamente.
    const expiresAt = held.reservation.paymentReported
      ? held.reservation.expiresAt || now.toISOString()
      : new Date(
          now.getTime() + REPORTED_HOLD_MINUTES * 60 * 1000
        ).toISOString();

    await extendHold(googleToken, held, expiresAt, extra);

    return res.status(200).json({ success: true, expiresAt });
  } catch (error) {
    console.error("Error report-payment:", error);

    if (error instanceof HttpError && !error.internal) {
      return res.status(error.status).json({ error: error.message });
    }

    return res.status(500).json({
      error: "No se pudo registrar el aviso de pago."
    });
  }
};
