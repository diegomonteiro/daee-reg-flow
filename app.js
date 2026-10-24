require('dotenv').config();
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var logger = require('morgan');
const compression = require('compression')

var indexRouter = require('./routes/index');
var apiRouter   = require('./routes/apis');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(compression());
app.disable('x-powered-by');
app.use(function(req, res, next) {
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
  const parser = ['/api/isohyet_simulation', '/api/isohyet_adjust'].includes(req.path) ? simulationJsonParser : standardJsonParser;
  parser(req, res, next);
});
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

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
  if (req.originalUrl.startsWith('/api/')) {
    if (err.type === 'entity.too.large') {
      return res.json({ error: 'A requisição descompactada excede o limite de 60 MB da simulação.' });
    }
    return res.json({ error: err.status && err.status < 500 ? err.message : 'Internal server error' });
  }
  res.render('error');
});

module.exports = app;
