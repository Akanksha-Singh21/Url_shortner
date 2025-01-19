CREATE DATABASE short_url_db;
USE short_url_db;
CREATE TABLE urls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    long_url TEXT NOT NULL,
    short_url VARCHAR(50) UNIQUE NOT NULL,
    custom_alias VARCHAR(50) UNIQUE,
    topic VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE url_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    alias VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_agent TEXT,
    ip_address VARCHAR(50),
    geolocation TEXT
);
