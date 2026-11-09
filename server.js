// API de pedidos al mayoreo - Repostería Dulce Mayoreo
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const productos = require('./productos.json');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// PIN del panel de administración. En Render ponlo como variable de entorno ADMIN_PIN.
const ADMIN_PIN = process.env.ADMIN_PIN || 'admin123';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pedidos.json');

// Reglas del negocio (la PWA las lee de /api/catalogo para mostrar los mismos totales)
const REGLAS = {
    diasAnticipacion: 2,
    descuentos: [            // de mayor a menor
        { desde: 8000, pct: 10 },
        { desde: 3000, pct: 5 }
    ],
    envio: { costo: 100, gratisDesde: 2500 }
};

// Etapas por las que pasa un pedido según el tipo de entrega
const FLUJO = {
    recoger:   ['Recibido', 'Confirmado', 'En preparación', 'Listo', 'Entregado'],
    domicilio: ['Recibido', 'Confirmado', 'En preparación', 'Listo', 'En camino', 'Entregado']
};

// ---------- Guardado en archivo ----------
function leerPedidos() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return []; }
}

function guardarPedidos(lista) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporal = DATA_FILE + '.tmp';
    fs.writeFileSync(temporal, JSON.stringify(lista, null, 2));
    fs.renameSync(temporal, DATA_FILE);
}

// ---------- Utilidades ----------
const redondear = n => Math.round(n * 100) / 100;

function fechaLocal(d) {
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mes}-${dia}`;
}

function siguienteFolio(lista) {
    const mayor = lista.reduce((m, p) => Math.max(m, Number(p.folio.replace('PED-', '')) || 0), 0);
    return 'PED-' + String(mayor + 1).padStart(4, '0');
}

function calcularTotales(lineas, tipoEntrega) {
    const subtotal = redondear(lineas.reduce((s, l) => s + l.importe, 0));
    const regla = REGLAS.descuentos.find(d => subtotal >= d.desde);
    const descuentoPct = regla ? regla.pct : 0;
    const descuento = redondear(subtotal * descuentoPct / 100);
    const base = redondear(subtotal - descuento);
    const envio = tipoEntrega === 'domicilio' && base < REGLAS.envio.gratisDesde ? REGLAS.envio.costo : 0;
    return { subtotal, descuentoPct, descuento, envio, total: redondear(base + envio) };
}

function validarPedido(body) {
    const b = body || {};
    const errores = [];

    const nombre = String(b.nombre || '').trim();
    const telefono = String(b.telefono || '').replace(/\D/g, '');
    const tipoEntrega = b.tipoEntrega;
    const direccion = String(b.direccion || '').trim();
    const fechaEntrega = String(b.fechaEntrega || '');
    const notas = String(b.notas || '').trim();

    if (nombre.length < 2 || nombre.length > 80) errores.push('Escribe el nombre del cliente o negocio.');
    if (telefono.length !== 10) errores.push('El teléfono debe tener 10 dígitos.');
    if (!FLUJO[tipoEntrega]) errores.push('Elige si recoges en tienda o es a domicilio.');
    if (tipoEntrega === 'domicilio' && (direccion.length < 8 || direccion.length > 160)) {
        errores.push('Escribe la dirección de entrega completa.');
    }

    const fechaMinima = new Date();
    fechaMinima.setDate(fechaMinima.getDate() + REGLAS.diasAnticipacion);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEntrega) || fechaEntrega < fechaLocal(fechaMinima)) {
        errores.push(`La fecha de entrega debe ser con al menos ${REGLAS.diasAnticipacion} días de anticipación.`);
    }
    if (notas.length > 300) errores.push('Las notas son muy largas (máximo 300 caracteres).');

    const items = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) errores.push('Agrega al menos un producto al pedido.');
    if (items.length > 30) errores.push('Un pedido puede tener máximo 30 productos distintos.');

    const lineas = [];
    const vistos = new Set();
    for (const item of items.slice(0, 30)) {
        const prod = productos.find(p => p.id === Number(item && item.id));
        const cantidad = Number(item && item.cantidad);
        if (!prod) { errores.push('Hay un producto que no existe en el catálogo.'); continue; }
        if (vistos.has(prod.id)) { errores.push(`${prod.nombre} aparece repetido.`); continue; }
        vistos.add(prod.id);
        if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 500) {
            errores.push(`Cantidad inválida en ${prod.nombre}.`);
            continue;
        }
        if (cantidad < prod.minimoMayoreo) {
            errores.push(`${prod.nombre}: el mínimo de mayoreo es ${prod.minimoMayoreo} (${prod.unidad}).`);
            continue;
        }
        lineas.push({
            id: prod.id,
            nombre: prod.nombre,
            unidad: prod.unidad,
            cantidad,
            precioUnitario: prod.precioMayoreo,
            importe: redondear(cantidad * prod.precioMayoreo)
        });
    }

    return { errores, datos: { nombre, telefono, tipoEntrega, direccion, fechaEntrega, notas, lineas } };
}

// ---------- Protección del panel de administración ----------
function pinValido(pin) {
    const a = Buffer.from(String(pin || ''));
    const b = Buffer.from(ADMIN_PIN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const intentos = new Map(); // ip -> { cuenta, hasta }
function bloqueado(ip) {
    const r = intentos.get(ip);
    return r && r.cuenta >= 10 && Date.now() < r.hasta;
}
function registrarFallo(ip) {
    const r = intentos.get(ip);
    if (!r || Date.now() > r.hasta) intentos.set(ip, { cuenta: 1, hasta: Date.now() + 15 * 60 * 1000 });
    else r.cuenta += 1;
}

function soloAdmin(req, res, next) {
    if (bloqueado(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    if (!pinValido(req.get('x-admin-pin'))) {
        registrarFallo(req.ip);
        return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    next();
}

// ---------- Rutas públicas ----------
app.get('/', (req, res) => {
    res.json({
        mensaje: 'API de pedidos de repostería funcionando',
        rutas: ['GET /api/catalogo', 'POST /api/pedidos', 'GET /api/pedidos/:folio?telefono=', 'POST /api/admin/login', 'GET /api/admin/pedidos', 'PATCH /api/admin/pedidos/:folio/estatus']
    });
});

app.get('/api/catalogo', (req, res) => {
    res.json({ productos, reglas: REGLAS });
});

// Crear un pedido
app.post('/api/pedidos', (req, res) => {
    const { errores, datos } = validarPedido(req.body);
    if (errores.length > 0) {
        return res.status(400).json({ error: errores[0], detalles: errores });
    }

    const lista = leerPedidos();
    const ahora = new Date().toISOString();
    const pedido = {
        folio: siguienteFolio(lista),
        cliente: { nombre: datos.nombre, telefono: datos.telefono },
        tipoEntrega: datos.tipoEntrega,
        direccion: datos.tipoEntrega === 'domicilio' ? datos.direccion : '',
        fechaEntrega: datos.fechaEntrega,
        notas: datos.notas,
        items: datos.lineas,
        ...calcularTotales(datos.lineas, datos.tipoEntrega),
        flujo: FLUJO[datos.tipoEntrega],
        estatus: 'Recibido',
        creado: ahora,
        historial: [{ estatus: 'Recibido', fecha: ahora }]
    };
    lista.push(pedido);
    guardarPedidos(lista);
    res.status(201).json(pedido);
});

// Seguimiento: el cliente necesita su folio y el teléfono con que pidió
app.get('/api/pedidos/:folio', (req, res) => {
    const telefono = String(req.query.telefono || '').replace(/\D/g, '');
    const pedido = leerPedidos().find(p => p.folio === String(req.params.folio).toUpperCase());
    if (!pedido || pedido.cliente.telefono !== telefono) {
        return res.status(404).json({ error: 'No encontramos un pedido con ese folio y teléfono.' });
    }
    res.json(pedido);
});

// ---------- Rutas de administración ----------
app.post('/api/admin/login', (req, res) => {
    if (bloqueado(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    if (!pinValido(req.body && req.body.pin)) {
        registrarFallo(req.ip);
        return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    res.json({ ok: true });
});

app.get('/api/admin/pedidos', soloAdmin, (req, res) => {
    const pedidos = leerPedidos().sort((a, b) =>
        a.fechaEntrega.localeCompare(b.fechaEntrega) || a.folio.localeCompare(b.folio));
    res.json({ pedidos });
});

// Avanzar al siguiente estatus del flujo, o cancelar
app.patch('/api/admin/pedidos/:folio/estatus', soloAdmin, (req, res) => {
    const lista = leerPedidos();
    const pedido = lista.find(p => p.folio === String(req.params.folio).toUpperCase());
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado.' });

    const nuevo = req.body && req.body.estatus;
    const terminado = pedido.estatus === 'Entregado' || pedido.estatus === 'Cancelado';
    const siguiente = pedido.flujo[pedido.flujo.indexOf(pedido.estatus) + 1];

    if (terminado) return res.status(409).json({ error: `El pedido ya está ${pedido.estatus.toLowerCase()}.` });
    if (nuevo !== 'Cancelado' && nuevo !== siguiente) {
        return res.status(400).json({ error: `Desde "${pedido.estatus}" solo puede pasar a "${siguiente}" o cancelarse.` });
    }

    pedido.estatus = nuevo;
    pedido.historial.push({ estatus: nuevo, fecha: new Date().toISOString() });
    guardarPedidos(lista);
    res.json(pedido);
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API de repostería escuchando en el puerto ' + PORT));
