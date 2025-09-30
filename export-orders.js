#!/usr/bin/env node

/**
 * Ordering.co Weekly Orders Export
 * Exports orders from last week (Monday to Sunday)
 * 
 * Usage:
 *   API_KEY=your_key BUSINESS_SLUG=your_slug node export-orders.js
 */

const https = require('https');
const fs = require('fs');

const BUSINESS_SLUG = process.env.BUSINESS_SLUG;
const API_KEY = process.env.API_KEY;

if (!API_KEY || !BUSINESS_SLUG) {
  console.error('Error: API_KEY and BUSINESS_SLUG are required');
  console.error('Usage: API_KEY=your_key BUSINESS_SLUG=your_slug node export-orders.js');
  process.exit(1);
}

function getLastWeekRange() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysToLastMonday = dayOfWeek === 0 ? 8 : dayOfWeek + 6;
  
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - daysToLastMonday);
  lastMonday.setHours(0, 0, 0, 0);
  
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  lastSunday.setHours(23, 59, 59, 999);
  
  return { lastMonday, lastSunday };
}

function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

function buildURL(startDate, endDate) {
  const where = [
    {
      "attribute": "delivery_datetime",
      "value": {
        "condition": ">=",
        "value": formatDate(startDate)
      }
    },
    {
      "attribute": "delivery_datetime",
      "value": {
        "condition": "<=",
        "value": formatDate(endDate)
      }
    },
    {
      "attribute": "status",
      "value": [11]
    }
  ];
  
  return `/v400/en/${BUSINESS_SLUG}/orders.csv?mode=dashboard&where=${encodeURIComponent(JSON.stringify(where))}&orderBy=id`;
}

function downloadCSV(url, filename) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'apiv4.ordering.co',
      path: url,
      headers: {
        'X-API-KEY': API_KEY,
        'Accept': 'text/csv'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      const fileStream = fs.createWriteStream(filename);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filename);
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    const { lastMonday, lastSunday } = getLastWeekRange();
    
    console.log('=== Ordering.co Weekly Export ===');
    console.log(`Date Range: ${lastMonday.toDateString()} to ${lastSunday.toDateString()}`);
    console.log(`Start: ${formatDate(lastMonday)}`);
    console.log(`End: ${formatDate(lastSunday)}`);
    
    const url = buildURL(lastMonday, lastSunday);
    console.log(`API URL: https://apiv4.ordering.co${url}`);
    
    const filename = `orders_${lastMonday.getFullYear()}-${String(lastMonday.getMonth() + 1).padStart(2, '0')}-${String(lastMonday.getDate()).padStart(2, '0')}_to_${lastSunday.getFullYear()}-${String(lastSunday.getMonth() + 1).padStart(2, '0')}-${String(lastSunday.getDate()).padStart(2, '0')}.csv`;
    
    console.log('Downloading orders...');
    await downloadCSV(url, filename);
    
    const stats = fs.statSync(filename);
    console.log(`File size: ${stats.size} bytes`);
    
    console.log(`✓ Success! Orders exported to: ${filename}`);
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  }
}

main();
