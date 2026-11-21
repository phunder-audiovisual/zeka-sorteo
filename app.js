
import { auth, db } from "./firebase.js";

import {
  collection,
  getDocs,
  doc,
  runTransaction,
  Timestamp,
  serverTimestamp,
  query,
  where,
  updateDoc
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

import {
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);

let currentRaffle = null;
let selectedNumbers = [];
let currentPublicTickets = [];
let ticketPrice = 1000;
let loadingRaffle = false;
let activeReservation = null;
let raffleIsOpen = false;

let reservationCountdownInterval = null;

function money(value) {
  return "$" + Number(value).toLocaleString("es-AR");
}

// TEMPORIZADOR DE RESERVA.
function showReservationCountdown(expiresAtMillis) {
  if (reservationCountdownInterval) {
    clearInterval(reservationCountdownInterval);
  }

  let countdown = $("reservationCountdown");

  if (!countdown) {
    countdown = document.createElement("div");
    countdown.id = "reservationCountdown";

    const notice = $("reservationNotice");

    if (notice) {
      notice.insertAdjacentElement("afterend", countdown);
    }
  }

  if (!countdown) return;

  countdown.style.display = "block";
  countdown.style.margin = "15px 0";
  countdown.style.padding = "15px";
  countdown.style.textAlign = "center";
  countdown.style.borderRadius = "10px";
  countdown.style.background = "#17251d";
  countdown.style.color = "#00e676";
  countdown.style.fontWeight = "bold";

  function updateCountdown() {
    const remaining = Math.max(
      0,
      Math.floor((expiresAtMillis - Date.now()) / 1000)
    );

    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    countdown.textContent =
      "⏳ TIEMPO PARA PAGAR: " +
      String(minutes).padStart(2, "0") +
      ":" +
      String(seconds).padStart(2, "0");

    if (remaining <= 0) {
      clearInterval(reservationCountdownInterval);
      reservationCountdownInterval = null;

      countdown.textContent =
        "⌛ Tu reserva venció. Los números pueden volver a estar disponibles.";

      countdown.style.color = "#ff5252";

      loadRaffle();
    }
  }

  updateCountdown();

  reservationCountdownInterval = setInterval(
    updateCountdown,
    1000
  );
}

// RECUPERAR RESERVA PENDIENTE.
async function restoreReservationCountdown() {
  try {
    if (!auth.currentUser || !currentRaffle) return;

    const reservationsQuery = query(
      collection(db, "reservations"),
      where("uid", "==", auth.currentUser.uid),
      where("raffleId", "==", currentRaffle.id)
    );

    const snapshot = await getDocs(reservationsQuery);
    const now = Date.now();

    const activeReservations = snapshot.docs
      .map(document => ({
        id: document.id,
        ...document.data()
      }))
      .filter(reservation =>
        reservation.status === "pending" &&
        reservation.expiresAt?.toMillis?.() > now
      );

    if (!activeReservations.length) {
      if (reservationCountdownInterval) {
        clearInterval(reservationCountdownInterval);
        reservationCountdownInterval = null;
      }

      activeReservation = null;

      const paymentPanel = $("paymentPanel");

      if (paymentPanel) {
        paymentPanel.hidden = true;
      }

      const countdown = $("reservationCountdown");

      if (countdown) {
        countdown.style.display = "none";
      }

      return;
    }

    activeReservations.sort((a, b) =>
      b.expiresAt.toMillis() - a.expiresAt.toMillis()
    );

    const reservation = activeReservations[0];

    $("reservationNotice").textContent =
      "✅ Encontramos tu reserva. Todavía tenés tiempo para completar el pago.";

    $("reservationNotice").hidden = false;
    $("reservationNotice").style.display = "block";

    showPaymentPanel(reservation);

    showReservationCountdown(
      reservation.expiresAt.toMillis()
    );

  } catch (error) {
    console.warn(
      "No se pudo recuperar la reserva del participante:",
      error
    );
  }
}

// MEDIOS DE PAGO.
const paymentAccounts = {
  mercadopago: {
    title: "Mercado Pago",
    alias: "zeka23.ok",
    cbu: "0000003100074625021621"
  },

  naranjax: {
    title: "Naranja X",
    alias: "zeka.ok",
    cbu: "4530000800018800623785"
  },

  cuentadni: {
    title: "Cuenta DNI",
    alias: "zeka.mateo.ok",
    cbu: "0140301303666259321902"
  }
};

function showPaymentPanel(reservation) {
  activeReservation = reservation;

  const panel = $("paymentPanel");
  const method = $("paymentMethod");
  const total = $("paymentTotal");

  if (!panel || !method || !total) return;

  panel.hidden = false;
  total.textContent = money(reservation.total || 0);

  method.value = reservation.paymentMethod || "";

  updatePaymentDetails();
}

// COLORES DE LOS MEDIOS DE PAGO.
function updatePaymentDetails() {
  const method = $("paymentMethod").value;
  const account = paymentAccounts[method];

  const details = $("paymentDetails");
  const panel = $("paymentPanel");
  const title = $("paymentTitle");
  const mpButton = $("mercadoPagoBtn");
  const doneButton = $("paymentDoneBtn");

  const colors = {
    mercadopago: {
      background: "#087FC1",
      border: "#42C7FF",
      text: "#FFFFFF"
    },

    naranjax: {
      background: "#7026A8",
      border: "#C77AFF",
      text: "#FFFFFF"
    },

    cuentadni: {
      background: "#087B45",
      border: "#42DF91",
      text: "#FFFFFF"
    }
  };

  if (!account) {
    details.hidden = true;
    mpButton.hidden = true;
    doneButton.hidden = true;

    panel.style.borderColor = "";
    panel.style.background = "";

    return;
  }

  const color = colors[method];
  const isMercadoPago = method === "mercadopago";

  details.hidden = false;
  title.textContent = account.title;

  mpButton.hidden = !isMercadoPago;
  doneButton.hidden = isMercadoPago;

  $("paymentAlias").hidden = isMercadoPago;
  $("paymentAlias").previousElementSibling.hidden = isMercadoPago;

  $("paymentCbu").hidden = isMercadoPago;
  $("paymentCbu").previousElementSibling.hidden = isMercadoPago;

  $("copyAliasBtn").hidden = isMercadoPago;
  $("copyCbuBtn").hidden = isMercadoPago;

  panel.style.border = "2px solid " + color.border;
  panel.style.background = color.background;
  panel.style.color = color.text;
  panel.style.borderRadius = "14px";
  panel.style.padding = "18px";

  title.style.color = color.text;

  $("paymentAlias").style.color = color.text;
  $("paymentCbu").style.color = color.text;

  $("paymentMethod").style.background = color.background;
  $("paymentMethod").style.color = color.text;
  $("paymentMethod").style.border =
    "2px solid " + color.border;
}

$("paymentMethod").addEventListener(
  "change",
  updatePaymentDetails
);

// COPIAR ALIAS Y CBU.
async function copyPaymentText(elementId) {
  const element = $(elementId);

  if (!element) return;

  const text = element.textContent;

  try {
    await navigator.clipboard.writeText(text);

    $("paymentMessage").textContent =
      "¡Copiado correctamente!";

  } catch (error) {
    $("paymentMessage").textContent =
      "No se pudo copiar. Mantené presionado el dato para copiarlo.";
  }
}

$("copyAliasBtn").addEventListener("click", () => {
  copyPaymentText("paymentAlias");
});

$("copyCbuBtn").addEventListener("click", () => {
  copyPaymentText("paymentCbu");
});

// MERCADO PAGO.
$("mercadoPagoBtn").addEventListener("click", async () => {
  const button = $("mercadoPagoBtn");
  const message = $("paymentMessage");

  if (!activeReservation ||
      activeReservation.status !== "pending") {
    message.textContent =
      "No hay una reserva pendiente para pagar.";
    return;
  }

  if (!auth.currentUser) {
    message.textContent =
      "No se pudo identificar al participante.";
    return;
  }

  button.disabled = true;
  message.textContent = "Conectando con Mercado Pago...";

  try {
    const token = await auth.currentUser.getIdToken();

    const response = await fetch("/api/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({
        reservationId: activeReservation.id
      })
    });

    const data = await response.json();

    if (!response.ok ||
        !data.success ||
        !data.checkoutUrl) {
      throw new Error(
        data.error || "No se pudo crear el pago."
      );
    }

    message.textContent = "Abriendo Mercado Pago...";

    window.location.href = data.checkoutUrl;

  } catch (error) {
    console.error(
      "Error al iniciar Mercado Pago:",
      error
    );

    message.textContent =
      error.message || "Error al conectar con Mercado Pago.";

    button.disabled = false;
  }
});

// INFORMAR TRANSFERENCIA.
$("paymentDoneBtn").addEventListener("click", async () => {
  const method = $("paymentMethod").value;
  const message = $("paymentMessage");
  const button = $("paymentDoneBtn");

  if (!activeReservation) {
    message.textContent =
      "No se encontró una reserva activa.";
    return;
  }

  if (!method || !paymentAccounts[method]) {
    message.textContent =
      "Primero seleccioná un medio de pago.";
    return;
  }

  if (activeReservation.status !== "pending") {
    message.textContent =
      "Esta reserva ya no está pendiente.";
    return;
  }

  button.disabled = true;
  message.textContent = "Registrando aviso de pago...";

  try {
    await updateDoc(
      doc(db, "reservations", activeReservation.id),
      {
        paymentMethod: method,
        paymentReported: true,
        paymentReportedAt: serverTimestamp()
      }
    );

    activeReservation.paymentMethod = method;
    activeReservation.paymentReported = true;

    message.textContent =
      "¡Pago informado! El administrador verificará tu transferencia.";

  } catch (error) {
    console.error(error);

    message.textContent =
      "No se pudo informar el pago. Intentá nuevamente.";

  } finally {
    button.disabled = false;
  }
});

// DISPONIBILIDAD DE NÚMEROS.
function isAvailable(ticket) {
  if (ticket.status === "available") return true;

  if (
    ticket.status === "reserved" &&
    ticket.expiresAt?.toMillis &&
    ticket.expiresAt.toMillis() <= Date.now()
  ) {
    return true;
  }

  return false;
}

// LIBERAR RESERVAS VENCIDAS.
async function releaseExpiredTickets(raffleId, publicTickets) {
  const now = Date.now();

  const expiredTickets = publicTickets.filter(ticket =>
    ticket.status === "reserved" &&
    ticket.expiresAt?.toMillis?.() <= now
  );

  if (!expiredTickets.length) return false;

  let releasedAny = false;

  for (
    let start = 0;
    start < expiredTickets.length;
    start += 100
  ) {
    const group = expiredTickets.slice(start, start + 100);

    try {
      const released = await runTransaction(
        db,
        async (transaction) => {
          const documents = [];

          for (const ticket of group) {
            const number = String(ticket.number).padStart(3, "0");

            const privateRef = doc(
              db,
              "raffles",
              raffleId,
              "tickets",
              number
            );

            const publicRef = doc(
              db,
              "raffles",
              raffleId,
              "publicTickets",
              number
            );

            const privateSnap = await transaction.get(privateRef);
            const publicSnap = await transaction.get(publicRef);

            documents.push({
              privateRef,
              publicRef,
              privateSnap,
              publicSnap
            });
          }

          const toRelease = [];

          for (const item of documents) {
            if (
              !item.privateSnap.exists() ||
              !item.publicSnap.exists()
            ) {
              continue;
            }

            const privateTicket = item.privateSnap.data();
            const publicTicket = item.publicSnap.data();

            const privateExpired =
              privateTicket.expiresAt?.toMillis?.() <= Date.now();

            const publicExpired =
              publicTicket.expiresAt?.toMillis?.() <= Date.now();

            const sameReservation =
              privateTicket.reservationUid &&
              privateTicket.reservationUid ===
                publicTicket.reservationUid &&
              privateTicket.reservationId;

            if (
              privateTicket.status === "reserved" &&
              publicTicket.status === "reserved" &&
              privateTicket.paid !== true &&
              privateExpired &&
              publicExpired &&
              sameReservation
            ) {
              toRelease.push(item);
            }
          }

          for (const item of toRelease) {
            transaction.update(item.privateRef, {
              status: "available",
              paid: false,
              participantName: null,
              participantPhone: null,
              reservationId: null,
              reservationUid: null,
              expiresAt: null
            });

            transaction.update(item.publicRef, {
              status: "available",
              reservationUid: null,
              expiresAt: null
            });
          }

          return toRelease.length > 0;
        }
      );

      if (released) releasedAny = true;

    } catch (error) {
      console.warn(
        "No se pudieron liberar algunos números vencidos:",
        error
      );
    }
  }

  return releasedAny;
}

// ACTUALIZAR SELECCIÓN.
function updateSelection() {
  $("selectedNumbers").textContent =
    selectedNumbers.length
      ? selectedNumbers
          .map(n => String(n).padStart(3, "0"))
          .join(", ")
      : "Todavía no seleccionaste números.";

  $("totalPrice").textContent =
    money(selectedNumbers.length * ticketPrice);

  $("participateBtn").disabled =
    !raffleIsOpen || selectedNumbers.length === 0;
}

// MOSTRAR NÚMEROS.
function renderNumbers(publicTickets, quantity) {
  const grid = $("numbersGrid");

  grid.replaceChildren();

  if (publicTickets.length !== quantity) {
    grid.textContent =
      "La disponibilidad todavía no está publicada.";
    return;
  }

  publicTickets.sort(
    (a, b) => Number(a.number) - Number(b.number)
  );

  publicTickets.forEach(ticket => {
    const number = Number(ticket.number);

    const button = document.createElement("button");

    button.type = "button";
    button.className = "number";
    button.textContent = String(number).padStart(3, "0");

    if (!raffleIsOpen) {
      button.classList.add("occupied");
      button.disabled = true;

    } else if (isAvailable(ticket)) {
      button.classList.add("available");

      if (selectedNumbers.includes(number)) {
        button.classList.add("selected");
      }

      button.addEventListener("click", () => {
        if (!raffleIsOpen) return;

        if (selectedNumbers.includes(number)) {
          selectedNumbers =
            selectedNumbers.filter(n => n !== number);

        } else {
          if (selectedNumbers.length >= 10) {
            $("reservationMessage").textContent =
              "Podés reservar un máximo de 10 números.";
            return;
          }

          selectedNumbers.push(number);
        }

        renderNumbers(currentPublicTickets, quantity);
        updateSelection();
      });

    } else {
      button.classList.add("occupied");
      button.disabled = true;
    }

    grid.appendChild(button);
  });
}

// CARGAR SORTEO.
async function loadRaffle() {
  if (loadingRaffle) return;

  loadingRaffle = true;

  try {
    $("raffleStatus").textContent =
      "Consultando Firebase...";

    const raffleSnapshot = await getDocs(
      collection(db, "raffles")
    );

    // IMPORTANTE:
    // También cargar sorteos cerrados para recuperar
    // reservas pendientes que todavía pueden pagarse.
    const raffles = raffleSnapshot.docs
      .map(document => ({
        id: document.id,
        ...document.data()
      }))
      .filter(raffle =>
        raffle.status === "open" ||
        raffle.status === "closed"
      )
      .sort((a, b) => {
        const timeA = a.createdAt?.toMillis?.() || 0;
        const timeB = b.createdAt?.toMillis?.() || 0;

        return timeB - timeA;
      });

    if (!raffles.length) {
      currentRaffle = null;
      raffleIsOpen = false;
      selectedNumbers = [];

      $("raffleName").textContent =
        "No hay sorteos activos";

      $("raffleStatus").textContent =
        "Sin sorteo";

      $("numbersGrid").textContent =
        "Próximamente habrá nuevos sorteos.";

      updateSelection();

      return;
    }

    currentRaffle = raffles[0];
    raffleIsOpen = currentRaffle.status === "open";

    if (!raffleIsOpen) {
      selectedNumbers = [];
    }

    ticketPrice = Number(currentRaffle.price) || 1000;

    $("raffleName").textContent =
      currentRaffle.name;

    $("raffleStatus").textContent =
      raffleIsOpen ? "Sorteo disponible" : "Venta cerrada";

    $("ticketPrice").textContent =
      money(ticketPrice);

    $("totalNumbers").textContent =
      currentRaffle.quantity;

    const winners = $("winnerCount");

    if (winners) {
      winners.textContent = currentRaffle.winners;
    }

    const sold = Number(currentRaffle.soldCount) || 0;
    const quantity = Number(currentRaffle.quantity) || 0;

    $("soldCount").textContent =
      `${sold} / ${quantity}`;

    $("progressBar").style.width =
      quantity
        ? `${Math.min(100, sold / quantity * 100)}%`
        : "0%";

    let ticketsSnapshot = await getDocs(
      collection(
        db,
        "raffles",
        currentRaffle.id,
        "publicTickets"
      )
    );

    currentPublicTickets = ticketsSnapshot.docs.map(
      document => ({
        id: document.id,
        ...document.data()
      })
    );

    // Liberar vencidos solamente mientras la venta está abierta.
    const released = raffleIsOpen
      ? await releaseExpiredTickets(
          currentRaffle.id,
          currentPublicTickets
        )
      : false;

    if (released) {
      ticketsSnapshot = await getDocs(
        collection(
          db,
          "raffles",
          currentRaffle.id,
          "publicTickets"
        )
      );

      currentPublicTickets = ticketsSnapshot.docs.map(
        document => ({
          id: document.id,
          ...document.data()
        })
      );
    }

    renderNumbers(
      currentPublicTickets,
      quantity
    );

    updateSelection();

    // Recuperar reservas incluso si la venta fue cerrada.
    await restoreReservationCountdown();

    $("raffleStatus").textContent =
      raffleIsOpen ? "Sorteo disponible" : "Venta cerrada";

  } catch (error) {
    console.error(
      "Error al cargar el sorteo:",
      error
    );

    $("raffleStatus").textContent =
      "Error de conexión";

    $("numbersGrid").textContent =
      "No se pudo cargar la información. Revisá tu conexión.";

  } finally {
    loadingRaffle = false;
  }
}

// PREPARAR USUARIO ANÓNIMO.
async function prepareAnonymousUser() {
  let unsubscribe = () => {};

  const user = await new Promise((resolve, reject) => {
    unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        unsubscribe();
        resolve(currentUser);
      },
      reject
    );
  });

  if (!user) {
    await signInAnonymously(auth);
  }
}

// MOSTRAR FORMULARIO.
$("participateBtn").addEventListener("click", () => {
  if (!raffleIsOpen || !selectedNumbers.length) return;

  $("participantForm").hidden = false;

  $("participantForm").scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
});

// PROCESAR RESERVA.
$("participantForm").addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const message = $("reservationMessage");
    const reserveButton = $("reserveBtn");

    const name = $("participantName").value.trim();
    const phone = $("participantPhone").value.trim();

    const numbers = [...selectedNumbers];

    if (!currentRaffle || !raffleIsOpen || !numbers.length) {
      message.textContent =
        "La venta está cerrada o no seleccionaste números.";
      return;
    }

    if (numbers.length > 10) {
      message.textContent =
        "Podés reservar un máximo de 10 números.";
      return;
    }

    if (name.length < 3 || phone.length < 8) {
      message.textContent =
        "Revisá tu nombre y teléfono.";
      return;
    }

    if (!auth.currentUser) {
      message.textContent =
        "No se pudo identificar al participante.";
      return;
    }

    reserveButton.disabled = true;

    message.textContent =
      "Verificando disponibilidad...";

    try {
      const uid = auth.currentUser.uid;
      const raffleId = currentRaffle.id;

      const reservationRef = doc(
        collection(db, "reservations")
      );

      const raffleRef = doc(
        db,
        "raffles",
        raffleId
      );

      const privateRefs = numbers.map(number =>
        doc(
          db,
          "raffles",
          raffleId,
          "tickets",
          String(number).padStart(3, "0")
        )
      );

      const publicRefs = numbers.map(number =>
        doc(
          db,
          "raffles",
          raffleId,
          "publicTickets",
          String(number).padStart(3, "0")
        )
      );

      const expiresAt = Timestamp.fromMillis(
        Date.now() + 15 * 60 * 1000
      );

      await runTransaction(
        db,
        async (transaction) => {
          // VERIFICAR QUE LA VENTA SIGA ABIERTA.
          const raffleSnap = await transaction.get(raffleRef);

          if (!raffleSnap.exists()) {
            throw new Error(
              "El sorteo ya no está disponible."
            );
          }

          if (raffleSnap.data().status !== "open") {
            throw new Error(
              "La venta fue cerrada. No se pueden crear nuevas reservas."
            );
          }

          const privateSnapshots = [];
          const publicSnapshots = [];

          for (const ref of privateRefs) {
            privateSnapshots.push(
              await transaction.get(ref)
            );
          }

          for (const ref of publicRefs) {
            publicSnapshots.push(
              await transaction.get(ref)
            );
          }

          // COMPROBAR DISPONIBILIDAD.
          for (let i = 0; i < numbers.length; i++) {
            const privateSnap = privateSnapshots[i];
            const publicSnap = publicSnapshots[i];

            if (
              !privateSnap.exists() ||
              !publicSnap.exists()
            ) {
              throw new Error(
                "Uno de los números no existe."
              );
            }

            const privateTicket = privateSnap.data();
            const publicTicket = publicSnap.data();

            const expired =
              privateTicket.status === "reserved" &&
              privateTicket.expiresAt?.toMillis?.() <= Date.now();

            const available =
              privateTicket.status === "available" ||
              expired;

            if (
              !available ||
              !isAvailable(publicTicket)
            ) {
              throw new Error(
                "El número " +
                String(numbers[i]).padStart(3, "0") +
                " ya no está disponible."
              );
            }
          }

          // CREAR RESERVA.
          transaction.set(reservationRef, {
            uid,
            raffleId,
            name,
            phone,

            numbers: numbers.map(number =>
              String(number).padStart(3, "0")
            ),

            total: numbers.length * ticketPrice,
            status: "pending",
            expiresAt,
            createdAt: serverTimestamp()
          });

          // MARCAR NÚMEROS COMO RESERVADOS.
          for (let i = 0; i < numbers.length; i++) {
            transaction.update(privateRefs[i], {
              status: "reserved",
              paid: false,
              participantName: name,
              participantPhone: phone,
              reservationId: reservationRef.id,
              reservationUid: uid,
              expiresAt
            });

            transaction.update(publicRefs[i], {
              status: "reserved",
              reservationUid: uid,
              expiresAt
            });
          }
        }
      );

      $("reservationNotice").textContent =
        "✅ ¡Reserva solicitada correctamente! Tenés 15 minutos para completar el pago.";

      $("reservationNotice").hidden = false;
      $("reservationNotice").style.display = "block";
      $("reservationNotice").style.color = "#00e676";
      $("reservationNotice").style.fontWeight = "bold";

      showReservationCountdown(
        expiresAt.toMillis()
      );

      selectedNumbers = [];

      updateSelection();

      $("participantForm").reset();
      $("participantForm").hidden = true;

      $("reservationNotice").scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

      await loadRaffle();

    } catch (error) {
      console.error(
        "Error al reservar:",
        error
      );

      message.textContent =
        error.message || "No se pudo completar la reserva.";

      await loadRaffle();

    } finally {
      reserveButton.disabled = false;
    }
  }
);

// INICIO.
updateSelection();

prepareAnonymousUser()
  .then(loadRaffle)
  .catch(error => {
    console.error(
      "Error de autenticación:",
      error
    );

    $("raffleStatus").textContent =
      "No se pudo iniciar la sesión.";
  });

// ACTUALIZAR DISPONIBILIDAD CADA 60 SEGUNDOS.
setInterval(() => {
  if (auth.currentUser && currentRaffle) {
    loadRaffle();
  }
}, 60 * 1000);
