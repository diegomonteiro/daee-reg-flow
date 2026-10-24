require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var logger = require('morgan');
const compression = require('compression')

var indexRouter = require('./routes/index');
var apiRouter   = require('./routes/apis');

var app = express();

function normalizeBasePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

const configuredBasePath = normalizeBasePath(process.env.BASE_PATH || '');

function resolveBasePath(req) {
  const forwardedPrefix = normalizeBasePath(req.headers['x-forwarded-prefix']);
  if (forwardedPrefix) return forwardedPrefix;
  if (req.originalUrl === '/reg-flow' || req.originalUrl.startsWith('/reg-flow/') || req.originalUrl.startsWith('/reg-flow?')) {
    return '/reg-flow';
  }
  if (configuredBasePath && (req.originalUrl === configuredBasePath || req.originalUrl.startsWith(`${configuredBasePath}/`) || req.originalUrl.startsWith(`${configuredBasePath}?`))) {
    return configuredBasePath;
  }
  return configuredBasePath;
}

app.locals.resolveBasePath = resolveBasePath;

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
if (process.env.TRUST_PROXY !== undefined) {
  const trustProxy = process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY === 'false' ? false : Number.isFinite(Number(process.env.TRUST_PROXY)) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
} else if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(logger(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(compression());
app.disable('x-powered-by');
app.use(function(req, res, next) {
  res.locals.basePath = resolveBasePath(req);
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self)',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://unpkg.com https://tile.openstreetmap.org https://*.tile.opentopomap.org https://datageo.ambiente.sp.gov.br; connect-src 'self' https://unpkg.com https://api.mapbox.com https://tile.openstreetmap.org https://*.tile.opentopomap.org https://datageo.ambiente.sp.gov.br; font-src 'self' data:"
  });
  next();
});
const standardJsonParser = express.json({ limit: '512kb' });
const simulationJsonParser = express.json({ limit: '60mb' });
app.use(function(req, res, next) {
  const isLargeSimulationRoute = /\/api\/(isohyet_simulation|isohyet_adjust)\/?$/.test(req.path);
  const parser = isLargeSimulationRoute ? simulationJsonParser : standardJsonParser;
  parser(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

const staticMiddleware = express.static(path.join(__dirname, 'public'));
const subpaths = [...new Set(['/reg-flow', configuredBasePath].filter(Boolean))];
subpaths.forEach(function(prefix) {
  app.use(prefix, staticMiddleware);
  app.use(prefix, indexRouter);
  app.use(`${prefix}/api`, apiRouter);
});

app.use(staticMiddleware);
app.use('/', indexRouter);
app.use('/api', apiRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  res.status(err.status || 500);
  if (req.originalUrl.startsWith('/api/') || /\/api(\/|$|\?)/.test(req.originalUrl)) {
    if (err.type === 'entity.too.large') {
      return res.json({ error: 'A requisição descompactada excede o limite de 60 MB da simulação.' });
    }
    return res.json({ error: err.status && err.status < 500 ? err.message : 'Internal server error' });
  }
  res.render('error');
});

module.exports = app;
