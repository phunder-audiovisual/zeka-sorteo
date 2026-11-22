"use strict";

const crypto = require("crypto");

const { getGoogleAccessToken } = require("../lib/google");
const { processReservation } = require("../lib/payments");

function safeEqualHex(a, b) {
  const first = Buffer.from(a, "hex");
  const second = Buffer.from(b, "hex");

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function verifySignature(req, orderId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];

  if (!secret || !signature || !requestId) {
    console.error("MP firma: faltan datos", {
      secretConfigured: Boolean(secret),
      signatureReceived: Boolean(signature),
      requestIdReceived: Boolean(requestId)
    });
    return false;
  }

  const parts = {};

  signature.split(",").forEach(part => {
    const [key, value] = part.trim().split("=");
    if (key && value) parts[key] = value;
  });

  const ts = parts.ts;
  const receivedHash = parts.v1;

  if (!ts || !/^[a-f0-9]{64}$/i.test(receivedHash || "")) {
    console.error("MP firma: formato inválido");
    return false;
  }

  // Mercado Pago firma el id en minúsculas cuando es alfanumérico.
  // Se aceptan las dos variantes por seguridad.
  const candidates = new Set([orderId, orderId.toLowerCase()]);

  for (const id of candidates) {
    const manifest = `id:${id};request-id:${requestId};ts:${ts};`;

    const expectedHash = crypto
      .createHmac("sha256", secret)
      .update(manifest)
      .digest("hex");

    if (safeEqualHex(receivedHash, expectedHash)) return true;
  }

  console.error("MP firma: hash no coincide", { orderId });
  return false;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const url = new URL(req.url, "https://localhost");

    const orderId = url.searchParams.get("data.id");
    const type = url.searchParams.get("type");

    if (
      type !== "order" ||
      !orderId ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(orderId)
    ) {
      return res.status(400).json({ error: "Notificación inválida." });
    }

    if (!verifySignature(req, orderId)) {
      return res.status(401).json({ error: "Firma no válida." });
    }

    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (!mpToken) {
      throw new Error("Falta MP_ACCESS_TOKEN.");
    }

    // Se consulta la orden directamente a Mercado Pago: nunca se confía
    // en los datos de la notificación.
    const mpResponse = await fetch(
      `https://api.mercadopago.com/v1/orders/${encodeURIComponent(orderId)}`,
      { headers: { Authorization: `Bearer ${mpToken}` } }
    );

    const order = await mpResponse.json();

    if (!mpResponse.ok) {
      throw new Error("No se pudo consultar la orden.");
    }

    const notProcessed = { received: true, processed: false };

    if (
      String(order.id).toLowerCase() !== orderId.toLowerCase() ||
      order.status !== "processed" ||
      order.status_detail !== "accredited"
    ) {
      return res.status(200).json(notProcessed);
    }

    const currency = order.currency || order.currency_id;

    if (currency !== "ARS") {
      return res.status(200).json(notProcessed);
    }

    const reservationId = order.external_reference;

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(200).json(notProcessed);
    }

    const paidAmount = Number(order.total_paid_amount);
    const orderAmount = Number(order.total_amount);

    if (
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(orderAmount) ||
      paidAmount <= 0 ||
      paidAmount !== orderAmount
    ) {
      return res.status(200).json(notProcessed);
    }

    const payments = order.transactions?.payments || [];

    if (
      payments.length === 0 ||
      payments.some(
        payment =>
          payment.status !== "processed" ||
          payment.status_detail !== "accredited"
      )
    ) {
      return res.status(200).json(notProcessed);
    }

    const accessToken = await getGoogleAccessToken();

    const result = await processReservation(accessToken, {
      reservationId,
      orderId,
      paidAmount,
      manual: false
    });

    console.log("Resultado webhook ZEKA:", result);

    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    console.error("Error webhook ZEKA:", error);

    // Un 500 hace que Mercado Pago reintente la notificación.
    return res.status(500).json({
      error: "No se pudo procesar la notificación."
    });
  }
};
