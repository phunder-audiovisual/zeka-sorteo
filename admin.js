
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
  deleteField
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const ADMIN_UID = "GJe2WMAvJsdLtaaqfYT38fjJOVh1";
const ZEKA_RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";

const $ = id => document.getElementById(id);

const loginForm = $("loginForm");
const loginSection = $("loginSection");
const dashboard = $("dashboard");
const loginMessage = $("loginMessage");
const raffleList = $("raffleList");
const raffleForm = $("raffleForm");

let currentRaffles = [];

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
// ESTADÍSTICAS
// --------------------------------------------------

async function loadStatistics() {
  try {
    const snapshot = await getDocs(
      collection(db, "reservations")
    );

    const paidReservations = snapshot.docs
      .map(item => item.data())
      .filter(item => item.status === "paid");

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
      showMessage(message, "El precio debe ser un número entero mayor a cero.", true);
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

    try {
      const raffleRef = doc(collection(db, "raffles"));

      const operations = [];

      operations.push({
        ref: raffleRef,
        data: {
          name,
          quantity,
          price,
          winners,
          status: "preparing",
          soldCount: 0,
          paidCount: 0,
          createdBy: auth.currentUser.uid,
          createdAt: serverTimestamp()
        }
      });

      for (let i = 1; i <= quantity; i++) {
        const number = String(i).padStart(3, "0");

        const privateRef = doc(
          db,
          "raffles",
          raffleRef.id,
          "tickets",
          number
        );

        const publicRef = doc(
          db,
          "raffles",
          raffleRef.id,
          "publicTickets",
          number
        );

        operations.push({
          ref: privateRef,
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
          ref: publicRef,
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
        const group = operations.slice(i, i + 400);

        group.forEach(operation => {
          batch.set(operation.ref, operation.data);
        });

        await batch.commit();
      }

      // El sorteo queda visible solamente cuando
      // todos sus números están creados.
      await updateDoc(raffleRef, {
        status: "open"
      });

      raffleForm.reset();
      $("numberCount").value = "100";
      $("ticketPrice").value = "1000";
      $("winnerCount").value = "2";

      updateEstimatedRevenue();

      showMessage(message, "Sorteo creado correctamente.");

      await loadRaffles();

    } catch (error) {
      console.error("Error creando sorteo:", error);

      showMessage(
        message,
        "No se pudo completar la creación: " + error.message,
        true
      );

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

async function loadRaffles() {
  raffleList.textContent = "Cargando sorteos...";

  try {
    const snapshot = await getDocs(
      collection(db, "raffles")
    );

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
        `${raffle.quantity} números · ${money(raffle.price)} · ${raffle.winners} ganadores`;

      const status = document.createElement("p");
      status.textContent = "Estado: " + (raffle.status || "desconocido");

      const id = document.createElement("p");
      id.textContent = "ID: " + raffle.id;

      const syncButton = document.createElement("button");
      syncButton.type = "button";
      syncButton.textContent = "Sincronizar números públicos";
      syncButton.addEventListener("click", async () => {
        syncButton.disabled = true;

        try {
          await syncPublicTickets(raffle);
          alert("Números públicos sincronizados.");
        } catch (error) {
          alert("Error al sincronizar: " + error.message);
        } finally {
          syncButton.disabled = false;
        }
      });

      const reservationsButton = document.createElement("button");
      reservationsButton.type = "button";
      reservationsButton.textContent = "Ver participantes y reservas";
      reservationsButton.style.marginLeft = "8px";
      reservationsButton.addEventListener("click", () => {
        loadReservations(raffle);
      });

      card.append(
        title,
        info,
        status,
        id,
        syncButton,
        reservationsButton
      );

      if (
        raffle.id === ZEKA_RAFFLE_ID &&
        raffle.status !== "drawn"
      ) {
        const drawButton = document.createElement("button");

        drawButton.type = "button";
        drawButton.textContent =
          raffle.status === "open"
            ? "Cerrar venta"
            : raffle.status === "closed"
              ? "Realizar sorteo"
              : "Sorteo en preparación";

        drawButton.style.display = "block";
        drawButton.style.marginTop = "12px";

        drawButton.disabled =
          raffle.status !== "open" &&
          raffle.status !== "closed";

        drawButton.addEventListener("click", async () => {
          if (
            raffle.status === "open" &&
            !confirm(
              "¿Querés cerrar la venta? Las reservas anteriores podrán completar sus pagos."
            )
          ) return;

          if (
            raffle.status === "closed" &&
            !confirm(
              "¿Querés realizar el sorteo? Se elegirán los 2 ganadores entre los números pagados."
            )
          ) return;

          drawButton.disabled = true;

          try {
            const idToken = await auth.currentUser.getIdToken();

            const endpoint = raffle.status === "open"
              ? "/api/close-raffle"
              : "/api/draw-raffle";

            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${idToken}`,
                "Content-Type": "application/json"
              }
            });

            const data = await response.json();

            if (!response.ok) {
              throw new Error(
                data.error || "No se pudo completar la operación."
              );
            }

            if (raffle.status === "open") {
              alert(
                "Venta cerrada. Las reservas anteriores podrán completar sus pagos."
              );
            } else {
              alert("¡Sorteo realizado correctamente!");
              window.open("/ruleta.html", "_blank");
            }

            await loadRaffles();

          } catch (error) {
            alert(error.message);
            await loadRaffles();

          } finally {
            drawButton.disabled = false;
          }
        });

        card.appendChild(drawButton);
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

    operations.push({
      ref: publicRef,
      data: publicData
    });
  });

  for (let i = 0; i < operations.length; i += 400) {
    const batch = writeBatch(db);

    operations.slice(i, i + 400).forEach(operation => {
      batch.set(
        operation.ref,
        operation.data,
        { merge: true }
      );
    });

    await batch.commit();
  }

  return operations.length;
}

// --------------------------------------------------
// VER PARTICIPANTES Y RESERVAS
// --------------------------------------------------

async function loadReservations(raffle) {
  const container = $("reservationsList");

  container.textContent = "Cargando participantes y reservas...";

  try {
    const snapshot = await getDocs(
      collection(db, "reservations")
    );

    const reservations = snapshot.docs
      .map(item => ({
        id: item.id,
        ...item.data()
      }))
      .filter(item => item.raffleId === raffle.id)
      .sort((a, b) =>
        (b.createdAt?.toMillis?.() || 0) -
        (a.createdAt?.toMillis?.() || 0)
      );

    container.replaceChildren();

    if (!reservations.length) {
      container.textContent =
        "Todavía no hay reservas para este sorteo.";
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
      total.textContent =
        "Total: " + money(reservation.total);

      const status = document.createElement("p");
      status.textContent =
        "Estado del pago: " + (reservation.status || "desconocido");

      const reservationId = document.createElement("small");
      reservationId.textContent =
        "Reserva: " + reservation.id;

      card.append(
        name,
        phone,
        numbers,
        total,
        status,
        reservationId
      );

      container.appendChild(card);
    });

  } catch (error) {
    console.error("Error cargando reservas:", error);

    container.textContent =
      "No se pudieron cargar las reservas: " + error.message;
  }
    }
                              
