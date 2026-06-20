const admin = require('firebase-admin');

const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.cert(serviceAccount)
});

module.exports = admin;