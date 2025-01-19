const express = require('express');
const shortid = require('shortid');
const db = require('../config/db');
const rateLimit = require('express-rate-limit');
const geoip = require('geoip-lite');
const os = require('os');
const moment = require('moment');

const router = express.Router();

// Rate Limiter: Allow max 10 requests per minute
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10,
    message: 'Too many requests from this IP, please try again later.',
});

router.post('/shorten', limiter, (req, res) => {
    const { longUrl, customAlias, topic } = req.body;

    if (!longUrl) {
        return res.status(400).json({ error: 'longUrl is required' });
    }

    const shortUrl = customAlias || shortid.generate();

    // Check if custom alias already exists
    const checkAliasQuery = 'SELECT * FROM urls WHERE custom_alias = ?';
    db.query(checkAliasQuery, [customAlias], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length > 0) {
            return res.status(400).json({ error: 'Custom alias already in use' });
        }

        // Insert into the database
        const insertQuery = `
            INSERT INTO urls (long_url, short_url, custom_alias, topic)
            VALUES (?, ?, ?, ?)
        `;
        db.query(insertQuery, [longUrl, shortUrl, customAlias || null, topic || null], (err, result) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to create short URL' });
            }

            const response = {
                shortUrl: `${req.protocol}://${req.get('host')}/${shortUrl}`,
                createdAt: new Date(),
            };

            res.status(201).json(response);
        });
    });
});

// Redirect Short URL API
router.get('/shorten/:alias', async (req, res) => {
    const alias = req.params.alias;

    // Find the long URL corresponding to the alias
    const findUrlQuery = 'SELECT * FROM urls WHERE short_url = ? OR custom_alias = ? LIMIT 1';
    db.query(findUrlQuery, [alias, alias], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'Short URL not found' });
        }

        const longUrl = results[0].long_url;

        // Extract analytics data
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.connection.remoteAddress || 'Unknown';
        const geo = geoip.lookup(ipAddress) || { country: 'Unknown', region: 'Unknown', city: 'Unknown' };
        const geolocation = `${geo.city}, ${geo.region}, ${geo.country}`;

        // Log the redirect event
        const insertAnalyticsQuery = `
            INSERT INTO url_analytics (alias, user_agent, ip_address, geolocation)
            VALUES (?, ?, ?, ?)
        `;
        db.query(insertAnalyticsQuery, [alias, userAgent, ipAddress, geolocation], (err) => {
            if (err) {
                console.error('Error logging analytics:', err.message);
            }
        });

        // Redirect to the original long URL
        res.redirect(longUrl);
    });
});

// Get URL Analytics API
router.get('/analytics/:alias', (req, res) => {
    const alias = req.params.alias;

    // Validate if alias exists
    const checkAliasQuery = 'SELECT * FROM urls WHERE short_url = ? OR custom_alias = ? LIMIT 1';
    db.query(checkAliasQuery, [alias, alias], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'Short URL not found' });
        }

        // Fetch analytics data for the alias
        const analyticsQuery = `
            SELECT 
                alias,
                DATE(timestamp) AS click_date,
                user_agent,
                COUNT(*) AS total_clicks,
                COUNT(DISTINCT ip_address) AS unique_users
            FROM url_analytics
            WHERE alias = ?
            GROUP BY alias, DATE(timestamp), user_agent
        `;

        db.query(analyticsQuery, [alias], (err, analyticsResults) => {
            if (err) {
                console.error('Error fetching analytics data:', err); // Log the error
                return res.status(500).json({ error: 'Error fetching analytics data' });
            }

            // Calculate total clicks
            const totalClicks = analyticsResults.reduce((sum, record) => sum + record.total_clicks, 0);

            // Get unique users
            const uniqueUsers = new Set(analyticsResults.map(record => record.ip_address)).size;

            // Calculate clicks by date for the last 7 days
            const sevenDaysAgo = moment().subtract(7, 'days').format('YYYY-MM-DD');
            const clicksByDate = {};

            analyticsResults.forEach((record) => {
                const clickDate = moment(record.click_date).format('YYYY-MM-DD');
                if (clickDate >= sevenDaysAgo) {
                    clicksByDate[clickDate] = (clicksByDate[clickDate] || 0) + record.total_clicks;
                }
            });

            const clicksByDateArray = Object.entries(clicksByDate).map(([date, count]) => ({
                date,
                clickCount: count,
            }));

            // Calculate OS type data
            const osTypeMap = {};
            analyticsResults.forEach((record) => {
                const userAgent = record.user_agent.toLowerCase();
                let osName = 'Other';

                if (userAgent.includes('windows')) osName = 'Windows';
                else if (userAgent.includes('mac')) osName = 'macOS';
                else if (userAgent.includes('linux')) osName = 'Linux';
                else if (userAgent.includes('android')) osName = 'Android';
                else if (userAgent.includes('ios') || userAgent.includes('iphone')) osName = 'iOS';

                osTypeMap[osName] = osTypeMap[osName] || { osName, uniqueClicks: 0, uniqueUsers: new Set() };
                osTypeMap[osName].uniqueClicks += record.total_clicks;
                osTypeMap[osName].uniqueUsers.add(record.ip_address);
            });

            const osTypeArray = Object.values(osTypeMap).map((osData) => ({
                osName: osData.osName,
                uniqueClicks: osData.uniqueClicks,
                uniqueUsers: osData.uniqueUsers.size,
            }));

            // Calculate device type data
            const deviceTypeMap = {};
            analyticsResults.forEach((record) => {
                const userAgent = record.user_agent.toLowerCase();
                let deviceName = 'desktop';

                if (userAgent.includes('mobile') || userAgent.includes('android') || userAgent.includes('iphone')) {
                    deviceName = 'mobile';
                }

                deviceTypeMap[deviceName] = deviceTypeMap[deviceName] || {
                    deviceName,
                    uniqueClicks: 0,
                    uniqueUsers: new Set(),
                };
                deviceTypeMap[deviceName].uniqueClicks += record.total_clicks;
                deviceTypeMap[deviceName].uniqueUsers.add(record.ip_address);
            });

            const deviceTypeArray = Object.values(deviceTypeMap).map((deviceData) => ({
                deviceName: deviceData.deviceName,
                uniqueClicks: deviceData.uniqueClicks,
                uniqueUsers: deviceData.uniqueUsers.size,
            }));

            // Final response
            const response = {
                totalClicks,
                uniqueUsers,
                clicksByDate: clicksByDateArray,
                osType: osTypeArray,
                deviceType: deviceTypeArray,
            };

            res.status(200).json(response);
        });
    });
});

// Get Topic-Based Analytics API
router.get('/analytics/topic/:topic', (req, res) => {
    const topic = req.params.topic;

    // Fetch all URLs associated with the given topic
    const topicUrlsQuery = 'SELECT * FROM urls WHERE topic = ?';
    db.query(topicUrlsQuery, [topic], (err, urlsResults) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (urlsResults.length === 0) {
            return res.status(404).json({ error: 'No URLs found for the specified topic' });
        }

        // Fetch analytics data for all URLs under this topic
        const aliases = urlsResults.map(url => `'${url.short_url}'`).join(',');
        const analyticsQuery = `
            SELECT 
                alias,
                DATE(timestamp) AS click_date,
                user_agent,
                COUNT(*) AS total_clicks,
                COUNT(DISTINCT ip_address) AS unique_users
            FROM url_analytics
            WHERE alias IN (${aliases})
            GROUP BY alias, DATE(timestamp)
        `;

        db.query(analyticsQuery, (err, analyticsResults) => {
            if (err) {
                return res.status(500).json({ error: 'Error fetching analytics data' });
            }

            // Total clicks and unique users for the topic
            let totalClicks = 0;
            const uniqueUsersSet = new Set();

            // Organize analytics by URL alias and date
            const clicksByDate = {};
            const urlsAnalytics = {};

            analyticsResults.forEach((record) => {
                totalClicks += record.total_clicks;
                uniqueUsersSet.add(record.ip_address);

                // Organize by date and alias
                const clickDate = moment(record.click_date).format('YYYY-MM-DD');
                if (!clicksByDate[clickDate]) clicksByDate[clickDate] = 0;
                clicksByDate[clickDate] += record.total_clicks;

                if (!urlsAnalytics[record.alias]) {
                    urlsAnalytics[record.alias] = { totalClicks: 0, uniqueUsers: new Set() };
                }
                urlsAnalytics[record.alias].totalClicks += record.total_clicks;
                urlsAnalytics[record.alias].uniqueUsers.add(record.ip_address);
            });

            // Format clicksByDate array
            const clicksByDateArray = Object.entries(clicksByDate).map(([date, count]) => ({
                date,
                clickCount: count,
            }));

            // Format URLs analytics data
            const urlsAnalyticsArray = Object.keys(urlsAnalytics).map((alias) => {
                const urlInfo = urlsResults.find(url => url.short_url === alias);
                return {
                    shortUrl: urlInfo.short_url,
                    totalClicks: urlsAnalytics[alias].totalClicks,
                    uniqueUsers: urlsAnalytics[alias].uniqueUsers.size,
                };
            });

            // Response object
            const response = {
                totalClicks,
                uniqueUsers: uniqueUsersSet.size,
                clicksByDate: clicksByDateArray,
                urls: urlsAnalyticsArray,
            };

            res.status(200).json(response);
        });
    });
});

// Get Overall Analytics API
// router.get('/analytics/overall', (req, res) => {
//     const userId = req.user.id; // Assuming `user_id` is stored in `req.user.id` after authentication

//     // Fetch all URLs created by the authenticated user
//     const userUrlsQuery = 'SELECT * FROM urls WHERE user_id = ?';
//     db.query(userUrlsQuery, [userId], (err, urlsResults) => {
//         if (err) {
//             return res.status(500).json({ error: 'Database error' });
//         }

//         if (urlsResults.length === 0) {
//             return res.status(404).json({ error: 'No URLs found for this user' });
//         }

//         // Fetch analytics data for all URLs created by the user
//         const aliases = urlsResults.map(url => `'${url.short_url}'`).join(',');
//         const analyticsQuery = `
//             SELECT 
//                 alias,
//                 DATE(timestamp) AS click_date,
//                 user_agent,
//                 COUNT(*) AS total_clicks,
//                 COUNT(DISTINCT ip_address) AS unique_users
//             FROM url_analytics
//             WHERE alias IN (${aliases})
//             GROUP BY alias, DATE(timestamp)
//         `;

//         db.query(analyticsQuery, (err, analyticsResults) => {
//             if (err) {
//                 return res.status(500).json({ error: 'Error fetching analytics data' });
//             }

//             // Initialize overall analytics
//             let totalClicks = 0;
//             const uniqueUsersSet = new Set();
//             const clicksByDate = {};
//             const osTypeMap = {};
//             const deviceTypeMap = {};

//             // Process analytics results
//             analyticsResults.forEach((record) => {
//                 totalClicks += record.total_clicks;
//                 uniqueUsersSet.add(record.ip_address);

//                 // Organize by date
//                 const clickDate = moment(record.click_date).format('YYYY-MM-DD');
//                 if (!clicksByDate[clickDate]) clicksByDate[clickDate] = 0;
//                 clicksByDate[clickDate] += record.total_clicks;

//                 // OS Type Data
//                 const userAgent = record.user_agent.toLowerCase();
//                 let osName = 'Other';

//                 if (userAgent.includes('windows')) osName = 'Windows';
//                 else if (userAgent.includes('mac')) osName = 'macOS';
//                 else if (userAgent.includes('linux')) osName = 'Linux';
//                 else if (userAgent.includes('android')) osName = 'Android';
//                 else if (userAgent.includes('ios') || userAgent.includes('iphone')) osName = 'iOS';

//                 osTypeMap[osName] = osTypeMap[osName] || { osName, uniqueClicks: 0, uniqueUsers: new Set() };
//                 osTypeMap[osName].uniqueClicks += record.total_clicks;
//                 osTypeMap[osName].uniqueUsers.add(record.ip_address);

//                 // Device Type Data
//                 let deviceName = 'desktop';

//                 if (userAgent.includes('mobile') || userAgent.includes('android') || userAgent.includes('iphone')) {
//                     deviceName = 'mobile';
//                 }

//                 deviceTypeMap[deviceName] = deviceTypeMap[deviceName] || { deviceName, uniqueClicks: 0, uniqueUsers: new Set() };
//                 deviceTypeMap[deviceName].uniqueClicks += record.total_clicks;
//                 deviceTypeMap[deviceName].uniqueUsers.add(record.ip_address);
//             });

//             // Format clicksByDate array
//             const clicksByDateArray = Object.entries(clicksByDate).map(([date, count]) => ({
//                 date,
//                 clickCount: count,
//             }));

//             // Format OS Type Data
//             const osTypeArray = Object.values(osTypeMap).map((osData) => ({
//                 osName: osData.osName,
//                 uniqueClicks: osData.uniqueClicks,
//                 uniqueUsers: osData.uniqueUsers.size,
//             }));

//             // Format Device Type Data
//             const deviceTypeArray = Object.values(deviceTypeMap).map((deviceData) => ({
//                 deviceName: deviceData.deviceName,
//                 uniqueClicks: deviceData.uniqueClicks,
//                 uniqueUsers: deviceData.uniqueUsers.size,
//             }));

//             // Final response object
//             const response = {
//                 totalUrls: urlsResults.length,
//                 totalClicks,
//                 uniqueUsers: uniqueUsersSet.size,
//                 clicksByDate: clicksByDateArray,
//                 osType: osTypeArray,
//                 deviceType: deviceTypeArray,
//             };

//             res.status(200).json(response);
//         });
//     });
// });



module.exports = router;
