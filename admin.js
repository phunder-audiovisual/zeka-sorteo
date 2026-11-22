import { auth, db } from "./firebase.js";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

import {
  collection,
  getDocs,
  doc,
  writeBatch,
  updateDoc,
  serverTimestamp,
  deleteField,
  query,
  where
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

// Solo sirve para mostrar u ocultar el panel. La seguridad real está en las
// reglas de Firestore y en las funciones de /api, que repiten esta comprobación.
const ADMIN_UID = "GJe2WMAvJsdLtaaqfYT38fjJOVh1";

const $ = id => document.getElementById(id);

const loginForm = $("loginForm");
const loginSection = $("loginSection");
const dashboard = $("dashboard");
const loginMessage = $("loginMessage");
const raffleList = $("raffleList");
const raffleForm = $("raffleForm");

let currentRaffles = [];

const STATUS_LABELS = {
  preparing: "Preparando números",
  open: "Venta abierta",
  closed: "Venta cerrada",
  drawn: "Sorteo realizado",
  failed: "Falló la creación"
};

function money(value) {
  return Number(value || 0).toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  });
}

function showMessage(element, message, error = false) {
  if (!element) return;

  element.textContent = message;
  element.style.color = error ? "#ff5252" : "#00c853";
}

// Llama a una función de /api como administrador.
async function callApi(endpoint, body) {
  if (!auth.currentUser) {
    throw new Error("Tu sesión venció. Volvé a iniciar sesión.");
  }

  const idToken = await auth.currentUser.getIdToken();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  // Si el servidor devuelve algo que no es JSON (por ejemplo un error de
  // Vercel), se muestra un mensaje claro en vez de "Unexpected token <".
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
      `El servidor respondió con un error (${response.status}).`
    );
  }

  return data;
}

// --------------------------------------------------
// INICIO DE SESIÓN
// --------------------------------------------------

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  showMessage(loginMessage, "Ingresando...");

  try {
    await signInWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
  } catch (error) {
    showMessage(
      loginMessage,
      "No se pudo iniciar sesión: " + error.message,
      true
    );
  }
});

onAuthStateChanged(auth, async user => {
  if (user && user.uid === ADMIN_UID) {
    loginSection.hidden = true;
    dashboard.hidden = false;

    showMessage(loginMessage, "");

    await loadRaffles();
    return;
  }

  dashboard.hidden = true;
  loginSection.hidden = false;

  if (user) {
    showMessage(
      loginMessage,
      "Esta cuenta no tiene permisos de administrador.",
      true
    );

    await signOut(auth);
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
});

// --------------------------------------------------
// ESTADÍSTICAS (reservas pagadas de todos los sorteos)
// --------------------------------------------------

async function loadStatistics() {
  try {
    const snapshot = await getDocs(
      query(
        collection(db, "reservations"),
        where("status", "==", "paid")
      )
    );

    const paidReservations = snapshot.docs.map(item => item.data());

    const participants = new Set(
      paidReservations
        .map(item => item.uid)
        .filter(Boolean)
    );

    const revenue = paidReservations.reduce(
      (total, item) => total + Number(item.total || 0),
      0
    );

    $("totalParticipants").textContent = participants.size;
    $("totalRevenue").textContent = money(revenue);

  } catch (error) {
    console.error("Error cargando estadísticas:", error);

    $("totalParticipants").textContent = "—";
    $("totalRevenue").textContent = "—";
  }
}

// --------------------------------------------------
// CREAR SORTEO
// --------------------------------------------------

if (raffleForm) {
  raffleForm.addEventListener("submit", async event => {
    event.preventDefault();

    const message = $("raffleMessage");

    const button = raffleForm.querySelector(
      'button[type="submit"]'
    );

    const name = $("raffleName").value.trim();
    const quantity = Number($("numberCount").value);
    const price = Number($("ticketPrice").value);
    const winners = Number($("winnerCount").value);

    if (!name || name.length < 3) {
      showMessage(message, "Ingresá un nombre válido.", true);
      return;
    }

    if (![100, 200, 300].includes(quantity)) {
      showMessage(message, "Cantidad de números no válida.", true);
      return;
    }

    if (!Number.isSafeInteger(price) || price < 1) {
      showMessage(
        message,
        "El precio debe ser un número entero mayor a cero.",
        true
      );
      return;
    }

    if (![1, 2, 3].includes(winners)) {
      showMessage(message, "Cantidad de ganadores no válida.", true);
      return;
    }

    if (!auth.currentUser || auth.currentUser.uid !== ADMIN_UID) {
      showMessage(message, "No estás autorizado.", true);
      return;
    }

    button.disabled = true;

    showMessage(message, "Creando sorteo y preparando números...");

    const raffleRef = doc(collection(db, "raffles"));
    let raffleCreated = false;

    try {
      const operations = [];

      operations.push({
        ref: raffleRef,
        data: {
          name,
          quantity,
          price,
          winners,
          status: "preparing",
          createdBy: auth.currentUser.uid,
          createdAt: serverTimestamp()
        }
      });

      for (let i = 1; i <= quantity; i++) {
        const number = String(i).padStart(3, "0");

        operations.push({
          ref: doc(db, "raffles", raffleRef.id, "tickets", number),
          data: {
            number,
            status: "available",
            participantName: null,
            participantPhone: null,
            paid: false,
            createdAt: serverTimestamp()
          }
        });

        operations.push({
          ref: doc(db, "raffles", raffleRef.id, "publicTickets", number),
          data: {
            number,
            status: "available"
          }
        });
      }

      // Firestore admite hasta 500 operaciones por lote.
      // Se usan lotes de 400 para mantener margen.
      for (let i = 0; i < operations.length; i += 400) {
        const batch = writeBatch(db);

        operations.slice(i, i + 400).forEach(operation => {
          batch.set(operation.ref, operation.data);
        });

        await batch.commit();

        // El primer lote contiene el documento del sorteo.
        raffleCreated = true;
      }

      // El sorteo queda visible solamente cuando
      // todos sus números están creados.
      await updateDoc(raffleRef, { status: "open" });

      raffleForm.reset();
      updateEstimatedRevenue();

      showMessage(message, "Sorteo creado correctamente.");

      await loadRaffles();

    } catch (error) {
      console.error("Error creando sorteo:", error);

      // Si el sorteo quedó a medias, se marca como fallido para que
      // nunca se publique con números incompletos.
      if (raffleCreated) {
        try {
          await updateDoc(raffleRef, { status: "failed" });
        } catch (markError) {
          console.error("No se pudo marcar el sorteo:", markError);
        }
      }

      showMessage(
        message,
        "No se pudo completar la creación: " + error.message,
        true
      );

      if (raffleCreated) {
        await loadRaffles();
      }

    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------
// ESTIMACIÓN DE RECAUDACIÓN
// --------------------------------------------------

function updateEstimatedRevenue() {
  const quantity = Number($("numberCount")?.value || 0);
  const price = Number($("ticketPrice")?.value || 0);
  const output = $("estimatedRevenue");

  if (output) {
    output.textContent = money(quantity * price);
  }
}

$("numberCount")?.addEventListener(
  "change",
  updateEstimatedRevenue
);

$("ticketPrice")?.addEventListener(
  "input",
  updateEstimatedRevenue
);

updateEstimatedRevenue();

// --------------------------------------------------
// CARGAR SORTEOS
// --------------------------------------------------

function createButton(text, onClick) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = text;
  button.style.marginTop = "8px";
  button.style.marginRight = "8px";
  button.addEventListener("click", onClick);

  return button;
}

function winnersText(raffle) {
  if (!Array.isArray(raffle.drawResults)) return "";

  return raffle.drawResults
    .map(
      (winner, index) =>
        `🏆 Ganador ${index + 1}: N° ${winner.number} — ${winner.name}`
    )
    .join("\n");
}

async function runRaffleAction(raffle, button) {
  const isClosing = raffle.status === "open";
  const count = Number(raffle.winners) || 1;

  const question = isClosing
    ? "¿Querés cerrar la venta? Las reservas anteriores podrán completar sus pagos."
    : `¿Querés realizar el sorteo? Se elegirá ${count === 1 ? "1 ganador" : count + " ganadores"} entre los números pagados.`;

  if (!confirm(question)) return;

  button.disabled = true;

  try {
    await callApi(
      isClosing ? "/api/close-raffle" : "/api/draw-raffle",
      { raffleId: raffle.id }
    );

    alert(
      isClosing
        ? "Venta cerrada. Las reservas anteriores podrán completar sus pagos."
        : "¡Sorteo realizado correctamente! Tocá «Ver ruleta en vivo» para mostrar los resultados."
    );
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    await loadRaffles();
  }
}

async function loadRaffles() {
  raffleList.textContent = "Cargando sorteos...";

  try {
    const snapshot = await getDocs(collection(db, "raffles"));

    currentRaffles = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    currentRaffles.sort((a, b) =>
      (b.createdAt?.toMillis?.() || 0) -
      (a.createdAt?.toMillis?.() || 0)
    );

    $("totalRaffles").textContent = currentRaffles.length;

    if (!currentRaffles.length) {
      raffleList.textContent = "Todavía no hay sorteos creados.";
      await loadStatistics();
      return;
    }

    raffleList.replaceChildren();

    currentRaffles.forEach(raffle => {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.style.marginBottom = "12px";

      const title = document.createElement("h3");
      title.textContent = raffle.name || "Sorteo sin nombre";

      const info = document.createElement("p");
      info.textContent =
        `${raffle.quantity} números · ${money(raffle.price)} · ${raffle.winners} ganador${raffle.winners === 1 ? "" : "es"}`;

      const status = document.createElement("p");
      status.textContent =
        "Estado: " + (STATUS_LABELS[raffle.status] || raffle.status || "desconocido");

      const id = document.createElement("p");
      id.textContent = "ID: " + raffle.id;

      card.append(title, info, status, id);

      if (raffle.status === "failed") {
        const warning = document.createElement("p");
        warning.style.color = "#ff5252";
        warning.textContent =
          "La creación se interrumpió. Este sorteo no se publica: creá uno nuevo.";
        card.appendChild(warning);
      }

      if (raffle.status !== "failed") {
        const syncButton = createButton(
          "Sincronizar números públicos",
          async () => {
            syncButton.disabled = true;

            try {
              await syncPublicTickets(raffle);
              alert("Números públicos sincronizados.");
            } catch (error) {
              alert("Error al sincronizar: " + error.message);
            } finally {
              syncButton.disabled = false;
            }
          }
        );

        const reservationsButton = createButton(
          "Ver participantes y reservas",
          () => loadReservations(raffle)
        );

        card.append(syncButton, reservationsButton);
      }

      if (raffle.status === "open" || raffle.status === "closed") {
        const actionButton = createButton(
          raffle.status === "open" ? "Cerrar venta" : "Realizar sorteo",
          () => runRaffleAction(raffle, actionButton)
        );

        actionButton.style.display = "block";
        actionButton.style.marginTop = "12px";

        card.appendChild(actionButton);
      }

      if (raffle.status === "drawn") {
        const winners = document.createElement("p");
        winners.style.whiteSpace = "pre-line";
        winners.textContent = winnersText(raffle);

        const link = document.createElement("a");
        link.href = "/ruleta.html?raffle=" + encodeURIComponent(raffle.id);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Ver ruleta en vivo";
        link.style.display = "inline-block";
        link.style.marginTop = "12px";

        card.append(winners, link);
      }

      raffleList.appendChild(card);
    });

    await loadStatistics();

  } catch (error) {
    console.error("Error cargando sorteos:", error);

    raffleList.textContent =
      "Error cargando sorteos: " + error.message;
  }
}

// --------------------------------------------------
// SINCRONIZAR NÚMEROS PÚBLICOS
// --------------------------------------------------

async function syncPublicTickets(raffle) {
  const privateSnapshot = await getDocs(
    collection(db, "raffles", raffle.id, "tickets")
  );

  const operations = [];

  privateSnapshot.docs.forEach(ticketDoc => {
    const ticket = ticketDoc.data();

    let publicStatus = "available";

    if (ticket.status === "reserved") {
      publicStatus = "reserved";
    } else if (
      ticket.status === "paid" ||
      ticket.paid === true
    ) {
      publicStatus = "occupied";
    }

    const publicRef = doc(
      db,
      "raffles",
      raffle.id,
      "publicTickets",
      ticketDoc.id
    );

    const publicData = {
      number: ticket.number || ticketDoc.id,
      status: publicStatus,

      reservationUid:
        publicStatus === "reserved"
          ? ticket.reservationUid || null
          : deleteField(),

      expiresAt:
        publicStatus === "reserved" && ticket.expiresAt
          ? ticket.expiresAt
          : deleteField()
    };

    operations.push({ ref: publicRef, data: publicData });
  });

  for (let i = 0; i < operations.length; i += 400) {
    const batch = writeBatch(db);

    operations.slice(i, i + 400).forEach(operation => {
      batch.set(operation.ref, operation.data, { merge: true });
    });

    await batch.commit();
  }

  return operations.length;
}

// --------------------------------------------------
// VER PARTICIPANTES Y RESERVAS
// --------------------------------------------------

const PAYMENT_METHOD_LABELS = {
  mercadopago: "Mercado Pago",
  naranjax: "Naranja X",
  cuentadni: "Cuenta DNI"
};

const RESERVATION_STATUS_LABELS = {
  pending: "Pendiente de pago",
  paid: "Pagada"
};

async function loadReservations(raffle) {
  const container = $("reservationsList");

  container.textContent = "Cargando participantes y reservas...";

  try {
    const snapshot = await getDocs(
      query(
        collection(db, "reservations"),
        where("raffleId", "==", raffle.id)
      )
    );

    const reservations = snapshot.docs
      .map(item => ({
        id: item.id,
        ...item.data()
      }))
      .sort((a, b) =>
        (b.createdAt?.toMillis?.() || 0) -
        (a.createdAt?.toMillis?.() || 0)
      );

    container.replaceChildren();

    const heading = document.createElement("h3");
    heading.textContent = "Reservas de: " + (raffle.name || raffle.id);
    container.appendChild(heading);

    if (!reservations.length) {
      const empty = document.createElement("p");
      empty.textContent = "Todavía no hay reservas para este sorteo.";
      container.appendChild(empty);
      return;
    }

    reservations.forEach(reservation => {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.style.marginBottom = "12px";

      const name = document.createElement("h3");
      name.textContent = reservation.name || "Sin nombre";

      const phone = document.createElement("p");
      phone.textContent =
        "Teléfono: " + (reservation.phone || "No informado");

      const numbers = document.createElement("p");
      numbers.textContent =
        "Números: " +
        (Array.isArray(reservation.numbers)
          ? reservation.numbers.join(", ")
          : "Sin números");

      const total = document.createElement("p");
      total.textContent = "Total: " + money(reservation.total);

      const status = document.createElement("p");
      status.textContent =
        "Estado del pago: " +
        (RESERVATION_STATUS_LABELS[reservation.status] ||
          reservation.status ||
          "desconocido");

      const reservationId = document.createElement("small");
      reservationId.textContent = "Reserva: " + reservation.id;

      card.append(name, phone, numbers, total, status);

      if (reservation.paymentMethod) {
        const method = document.createElement("p");
        method.textContent =
          "Medio de pago: " +
          (PAYMENT_METHOD_LABELS[reservation.paymentMethod] ||
            reservation.paymentMethod) +
          (reservation.paymentReported && reservation.status === "pending"
            ? " · el cliente avisó que ya pagó"
            : "");
        card.appendChild(method);
      }

      if (reservation.paymentIssue) {
        const issue = document.createElement("p");
        issue.style.color = "#ff5252";
        issue.style.fontWeight = "bold";
        issue.textContent =
          "⚠️ Pago con problema (revisá y devolvé el dinero si corresponde): " +
          reservation.paymentIssue +
          (reservation.mpOrderId
            ? " · Orden de Mercado Pago: " + reservation.mpOrderId
            : "");
        card.appendChild(issue);
      }

      if (reservation.status === "pending") {
        const expires = reservation.expiresAt?.toDate?.();

        if (expires) {
          const expiry = document.createElement("p");
          expiry.textContent =
            "Los números quedan reservados hasta: " +
            expires.toLocaleString("es-AR");
          card.appendChild(expiry);
        }

        const confirmButton = createButton(
          "Confirmar pago recibido",
          async () => {
            if (
              !confirm(
                `¿Confirmás que recibiste ${money(reservation.total)} de ${reservation.name || "este participante"}? Los números pasarán a pagados.`
              )
            ) return;

            confirmButton.disabled = true;

            try {
              await callApi("/api/confirm-payment", {
                reservationId: reservation.id
              });

              alert("Pago confirmado.");
              await loadRaffles();
              await loadReservations(raffle);
            } catch (error) {
              alert(error.message);
              confirmButton.disabled = false;
            }
          }
        );

        card.appendChild(confirmButton);
      }

      card.appendChild(reservationId);
      container.appendChild(card);
    });

  } catch (error) {
    console.error("Error cargando reservas:", error);

    container.textContent =
      "No se pudieron cargar las reservas: " + error.message;
  }
}
