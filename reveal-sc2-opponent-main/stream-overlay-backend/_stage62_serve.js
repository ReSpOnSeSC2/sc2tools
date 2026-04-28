const path  = require('path');
const express = require('express');
const analyzer = require(path.resolve(process.argv[2]));
const app = express();
app.use(express.json());
app.use('/api/analyzer', analyzer.router);
const port = Number(process.env.PORT || 4733);
app.listen(port, '127.0.0.1', () => console.log('STAGE62_VERIFY ready', port));
