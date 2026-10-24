var express = require('express');
var router  = express.Router();
/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});

/* GET Swagger / OpenAPI UI page. */
router.get(['/api-docs', '/api/docs'], function(req, res) {
  res.render('api-docs', { title: 'REG-FLOW — API Docs (Swagger / OpenAPI)' });
});

module.exports = router;
