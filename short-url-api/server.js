const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();
const db = require('./config/db');
const shortUrlRoutes = require('./routes/shortUrl');

const app = express();

// Middleware
app.use(bodyParser.json());

// Routes
app.use('/api', shortUrlRoutes);

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
