const express = require('express');
const mongoose = require('mongoose');
const shortId = require('shortid');
const dotenv = require('dotenv');
const path = require('path');
const https = require('https');

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Environment configuration
const NODE_ENV = process.env.NODE_ENV || 'development';
const COLLECTION_PREFIX = NODE_ENV === 'production' ? 'prod_' : 'test_';

// Get service IP address
app.get('/ip', async (req, res) => {
  try {
    const response = await new Promise((resolve, reject) => {
      https.get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    res.json({ ip: response.ip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get IP address' });
  }
});

// Authentication middleware
const authenticateAdmin = (req, res, next) => {
  const receivedPassword = req.headers['x-admin-password']?.trim();
  const envPassword = process.env.ADMIN_PASSWORD?.trim();
  
  // Normalize passwords by replacing multiple $ with single $
  const normalizedReceivedPassword = receivedPassword?.replace(/\$\+/g, '$');
  const normalizedEnvPassword = envPassword?.replace(/\$\+/g, '$');
  
  if (normalizedReceivedPassword === normalizedEnvPassword) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log(`Connected to MongoDB (${NODE_ENV} environment)`))
  .catch(err => console.error('MongoDB connection error:', err));

// Click Event Schema
const clickEventSchema = new mongoose.Schema({
  urlId: { type: mongoose.Schema.Types.ObjectId, ref: 'Url' },
  timestamp: { type: Date, default: Date.now },
  ip: String,
  userAgent: String,
  referrer: String,
  country: String,
  city: String,
  device: String,
  browser: String,
  os: String
});

// URL Schema
const urlSchema = new mongoose.Schema({
  originalUrl: String,
  shortCode: String,
  clicks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastClicked: Date,
  uniqueVisitors: { type: Number, default: 0 },
  countries: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  operatingSystems: { type: Map, of: Number, default: {} }
});

// Create models with environment-specific collection names
const Url = mongoose.model('Url', urlSchema, `${COLLECTION_PREFIX}urls`);
const ClickEvent = mongoose.model('ClickEvent', clickEventSchema, `${COLLECTION_PREFIX}clicks`);

// Helper function to parse user agent
function parseUserAgent(userAgent) {
  // This is a simple implementation - you might want to use a proper UA parser library
  const ua = userAgent.toLowerCase();
  return {
    device: ua.includes('mobile') ? 'Mobile' : 'Desktop',
    browser: ua.includes('chrome') ? 'Chrome' : 
             ua.includes('firefox') ? 'Firefox' : 
             ua.includes('safari') ? 'Safari' : 
             ua.includes('edge') ? 'Edge' : 'Other',
    os: ua.includes('windows') ? 'Windows' : 
        ua.includes('mac') ? 'MacOS' : 
        ua.includes('linux') ? 'Linux' : 
        ua.includes('android') ? 'Android' : 
        ua.includes('ios') ? 'iOS' : 'Other'
  };
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Public route to create short URL
app.post('/shorten', async (req, res) => {
  const { originalUrl } = req.body;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    let url = await Url.findOne({ originalUrl });
    
    if (url) {
      return res.json({
        shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
        message: 'URL already exists'
      });
    }

    const shortCode = shortId.generate();
    url = new Url({
      originalUrl,
      shortCode
    });

    await url.save();
    res.json({
      shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
      message: 'URL shortened successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Protected admin route to create short URL (keeping for backward compatibility)
app.post('/admin/shorten', authenticateAdmin, async (req, res) => {
  const { originalUrl } = req.body;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    let url = await Url.findOne({ originalUrl });
    
    if (url) {
      return res.json({
        shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
        message: 'URL already exists'
      });
    }

    const shortCode = shortId.generate();
    url = new Url({
      originalUrl,
      shortCode
    });

    await url.save();
    res.json({
      shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
      message: 'URL shortened successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Redirect and track
app.get('/:shortCode', async (req, res) => {
  try {
    const url = await Url.findOne({ shortCode: req.params.shortCode });
    
    if (url) {
      // Update URL stats
      url.clicks++;
      url.lastClicked = new Date();
      
      // Parse user agent
      const uaInfo = parseUserAgent(req.headers['user-agent']);
      
      // Update device stats
      url.devices.set(uaInfo.device, (url.devices.get(uaInfo.device) || 0) + 1);
      url.browsers.set(uaInfo.browser, (url.browsers.get(uaInfo.browser) || 0) + 1);
      url.operatingSystems.set(uaInfo.os, (url.operatingSystems.get(uaInfo.os) || 0) + 1);
      
      // Create click event
      const clickEvent = new ClickEvent({
        urlId: url._id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        referrer: req.headers.referer || 'Direct',
        country: req.headers['cf-ipcountry'] || 'Unknown', // If using Cloudflare
        city: req.headers['cf-ipcity'] || 'Unknown', // If using Cloudflare
        ...uaInfo
      });

      await Promise.all([
        url.save(),
        clickEvent.save()
      ]);

      return res.redirect(url.originalUrl);
    }
    res.status(404).json({ error: 'URL not found' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get stats
app.get('/stats/:shortCode', async (req, res) => {
  try {
    const url = await Url.findOne({ shortCode: req.params.shortCode });
    if (url) {
      return res.json({
        originalUrl: url.originalUrl,
        shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
        clicks: url.clicks,
        createdAt: url.createdAt,
        lastClicked: url.lastClicked,
        devices: Object.fromEntries(url.devices),
        browsers: Object.fromEntries(url.browsers),
        operatingSystems: Object.fromEntries(url.operatingSystems)
      });
    }
    res.status(404).json({ error: 'URL not found' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all URLs (protected admin route)
app.get('/admin/urls', authenticateAdmin, async (req, res) => {
  try {
    const urls = await Url.find().sort({ createdAt: -1 });
    res.json(urls.map(url => ({
      originalUrl: url.originalUrl,
      shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
      clicks: url.clicks,
      createdAt: url.createdAt,
      lastClicked: url.lastClicked,
      shortCode: url.shortCode,
      devices: Object.fromEntries(url.devices),
      browsers: Object.fromEntries(url.browsers),
      operatingSystems: Object.fromEntries(url.operatingSystems)
    })));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit URL (protected admin route)
app.put('/admin/urls/:shortCode', authenticateAdmin, async (req, res) => {
  const { shortCode } = req.params;
  const { originalUrl } = req.body;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const url = await Url.findOne({ shortCode });
    
    if (!url) {
      return res.status(404).json({ error: 'URL not found' });
    }

    // Check if the new URL already exists
    const existingUrl = await Url.findOne({ originalUrl });
    if (existingUrl && existingUrl.shortCode !== shortCode) {
      return res.status(400).json({ error: 'URL already exists' });
    }

    url.originalUrl = originalUrl;
    await url.save();

    res.json({
      shortUrl: `${process.env.BASE_URL}/${url.shortCode}`,
      message: 'URL updated successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${NODE_ENV} mode`);
});