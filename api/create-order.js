"use strict";

const crypto = require("crypto");

const {
  HttpError,
  readBearerToken,
  lookupUser,
  getGoogleAccessToken
} = require("../lib/google");

const { loadHeldReservation, extendHold } = require("../lib/payments");

// Al pasar a Mercado Pago, la reserva se alarga una sola vez para que el
// cliente tenga tiempo de pagar sin que le liberen los números.
const CHECKOUT_HOLD_MINUTES = 20;

function stableIdempotencyKey(reservationId) {
  const hash = crypto
    .createHash("sha256")
    .update(reservationId)
    .digest("hex")
    .slice(0, 32)
    .split("");

  hash[12] = "4";
  hash[16] = ((parseInt(hash[16], 16) & 3) | 8).toString(16);

  const value = hash.join("");

  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join("-");
}

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

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(400).json({
        error: "Identificador de reserva inválido."
      });
    }

    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (!mpToken) {
      return res.status(500).json({
        error: "Falta configurar Mercado Pago."
      });
    }

    const uid = await lookupUser(idToken);

    if (!uid) {
      return res.status(401).json({ error: "Tenés que iniciar sesión." });
    }

    const googleToken = await getGoogleAccessToken();

    // Verifica dueño, vencimiento, sorteo, precio y números de la reserva.
    const held = await loadHeldReservation(googleToken, reservationId, {
      expectedUid: uid,
      allowExpired: false
    });

    const count = held.reservation.numbers.length;
    const total = held.reservation.total; // ya validado: cantidad × precio

    const order = {
      type: "online",
      processing_mode: "manual",
      capture_mode: "automatic_async",
      total_amount: total.toFixed(2),
      external_reference: reservationId,
      description: "ZEKA-SORTEO - Participación",
      items: [
        {
          title: "Número de ZEKA-SORTEO",
          quantity: count,
          unit_price: held.price.toFixed(2)
        }
      ]
    };

    const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": stableIdempotencyKey(reservationId)
      },
      body: JSON.stringify(order)
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok || !mpData.checkout_url) {
      console.error("Error Mercado Pago:", mpData);

      return res.status(502).json({
        error: "Mercado Pago no pudo crear la orden de pago."
      });
    }

    // Alarga la reserva una sola vez. Si falla no se corta el pago: el
    // webhook acepta pagos que lleguen después del vencimiento.
    if (!held.reservation.checkoutStarted) {
      try {
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + CHECKOUT_HOLD_MINUTES * 60 * 1000
        ).toISOString();

        await extendHold(googleToken, held, expiresAt, {
          checkoutStartedAt: { timestampValue: now.toISOString() }
        });
      } catch (error) {
        console.error("No se pudo alargar la reserva:", error);
      }
    }

    return res.status(200).json({
      success: true,
      orderId: mpData.id,
      checkoutUrl: mpData.checkout_url,
      total
    });
  } catch (error) {
    console.error("Error create-order:", error);

    if (error instanceof HttpError && !error.internal) {
      return res.status(error.status).json({ error: error.message });
    }

    return res.status(500).json({ error: "No se pudo preparar el pago." });
  }
};
