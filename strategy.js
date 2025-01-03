import axios from 'axios';
import axiosRetry from 'axios-retry';
import moment from 'moment';
import { sendTelegramMessage, editTelegramMessage } from './telegram.js';
import fs from 'fs';

// Define log file paths
const RSI_LOG_FILE = './rsi_data.csv';
const BUY_SIGNAL_LOG_FILE = './buy_signals.csv';

// Global constants
const RSI_PERIOD = 14;
const RSI_THRESHOLD_15m = 10;
const RSI_THRESHOLD_5m = 15;
const RSI_THRESHOLD_1m = 25;
const API_RETRIES = 3; // Retry attempts for API calls
const API_TIMEOUT = 5000; // API timeout in milliseconds

// Configure Axios with retry logic
axiosRetry(axios, { retries: API_RETRIES });
axios.defaults.timeout = API_TIMEOUT;

// Global trackers
const lastNotificationTimes = {};
const sellPrices = {};
const bottomPrices = {};
const entryPrices = {};
let lastBTCPrice = null;
const btcPriceHistory = [];

// Initialize log files
const initializeLogFiles = () => {
  if (!fs.existsSync(RSI_LOG_FILE)) {
    fs.writeFileSync(RSI_LOG_FILE, 'Timestamp,Symbol,RSI_15m,RSI_5m,RSI_1m,Current Price\n');
  }
  if (!fs.existsSync(BUY_SIGNAL_LOG_FILE)) {
    fs.writeFileSync(
      BUY_SIGNAL_LOG_FILE,
      'Timestamp,Symbol,RSI_15m,RSI_5m,RSI_1m,Buy Price,Sell Price,Duration,Bottom Price,Percentage Drop,BTC Change,BTC 30m Change\n'
    );
  }
};
initializeLogFiles();

// Retry API calls
const retryApiCall = async (fn, retries = API_RETRIES) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'ECONNRESET') {
        console.error('Connection reset by peer. Retry after some time.');
      }
      if (attempt === retries) {
        console.error('API call failed after retries:', error);
        return null;
      }
      console.warn(`Retrying API call (${attempt}/${retries})...`);
    }
  }
};

// Function to calculate RSI
const calculateRSI = (prices, period = RSI_PERIOD) => {
  if (prices.length < period) return null;

  let gains = 0,
    losses = 0;
  for (let i = 1; i < period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

// Fetch candlestick data
const fetchCandlestickData = async (symbol, interval) => {
  return retryApiCall(async () => {
    const url = `https://api.binance.com/api/v3/klines`;
    const params = {
      symbol,
      interval,
      limit: RSI_PERIOD + 1,
    };

    const response = await axios.get(url, { params });
    return response.data.map((candle) => parseFloat(candle[4])); // Closing prices
  });
};

// Fetch and calculate RSI for a specific interval
const fetchAndCalculateRSI = async (symbol, interval) => {
  const prices = await fetchCandlestickData(symbol, interval);
  return prices ? calculateRSI(prices) : null;
};

// Fetch 15-minute RSI
const fetch15mRSI = async (symbol) => fetchAndCalculateRSI(symbol, '15m');

// Fetch current BTC price and maintain history
const fetchBTCPrice = async () => {
  return retryApiCall(async () => {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
      params: { symbol: 'BTCUSDT' },
    });
    const price = parseFloat(response.data.price);

    btcPriceHistory.push({
      price,
      timestamp: moment(),
    });

    // Keep only last 31 minutes of history
    const thirtyOneMinutesAgo = moment().subtract(31, 'minutes');
    while (btcPriceHistory.length > 0 && btcPriceHistory[0].timestamp.isBefore(thirtyOneMinutesAgo)) {
      btcPriceHistory.shift();
    }

    return price;
  });
};

// Calculate BTC price changes
const calculateBTCChanges = async () => {
  const currentBTCPrice = await fetchBTCPrice();
  if (!currentBTCPrice) return { price: null, change: null, change30m: null };

  let priceChange = null;
  if (lastBTCPrice) {
    priceChange = ((currentBTCPrice - lastBTCPrice) / lastBTCPrice * 100).toFixed(2);
  }

  let priceChange30m = null;
  if (btcPriceHistory.length > 0) {
    const thirtyMinutesAgo = moment().subtract(30, 'minutes');
    const oldPrice = btcPriceHistory.find((entry) => entry.timestamp.isSameOrBefore(thirtyMinutesAgo));
    if (oldPrice) {
      priceChange30m = ((currentBTCPrice - oldPrice.price) / oldPrice.price * 100).toFixed(2);
    }
  }

  lastBTCPrice = currentBTCPrice;
  return {
    price: currentBTCPrice,
    change: priceChange,
    change30m: priceChange30m,
  };
};

// Log RSI and price data
const logRSIAndPrice = (symbol, rsi15m, rsi5m, rsi1m, currentPrice) => {
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  const logData = `${timestamp},${symbol},${rsi15m},${rsi5m},${rsi1m},${currentPrice}\n`;

  fs.appendFile(RSI_LOG_FILE, logData, (err) => {
    if (err) console.error('Error writing to RSI log file:', err);
    else console.log(`Logged RSI and price for ${symbol}`);
  });
};

// Log buy signals
const logBuySignal = (symbol, rsi15m, rsi5m, rsi1m, buyPrice, sellPrice, duration, bottomPrice, percentageDrop, btcChange, btcChange30m) => {
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  const logData = `${timestamp},${symbol},${rsi15m},${rsi5m},${rsi1m},${buyPrice},${sellPrice},${duration},${bottomPrice},${percentageDrop},${btcChange},${btcChange30m}\n`;

  fs.appendFile(BUY_SIGNAL_LOG_FILE, logData, (err) => {
    if (err) console.error('Error writing to buy_signals.csv:', err);
    else console.log(`Logged Buy Signal for ${symbol}`);
  });
};

// Handle RSI logic with multiple entry points
export const handleRSI = async (symbol, token, chatIds) => {
  const rsi15m = await fetch15mRSI(symbol);
  const prices5m = await fetchCandlestickData(symbol, '5m');
  const prices1m = await fetchCandlestickData(symbol, '1m');
  const btcData = await calculateBTCChanges();

  if (!prices5m || !prices1m || rsi15m === null) return;

  const rsi5m = calculateRSI(prices5m);
  const rsi1m = calculateRSI(prices1m);
  const currentPrice = prices1m[prices1m.length - 1];

  console.log(`RSI for ${symbol}: 15m = ${rsi15m}, 5m = ${rsi5m}, 1m = ${rsi1m}, Price = ${currentPrice}`);

  // Log RSI and price data
  logRSIAndPrice(symbol, rsi15m, rsi5m, rsi1m, currentPrice);

  const existingSignal = sellPrices[symbol];
  if (existingSignal) {
    if (
      currentPrice < existingSignal.sellPrice &&
      (entryPrices[symbol].length === 0 || currentPrice <= entryPrices[symbol][0] * 0.99)
    ) {
      entryPrices[symbol].unshift(currentPrice);

      const updatedMessage = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices[symbol].join('-')}
💰 Sell Price: ${existingSignal.sellPrice}
🕒 Timeframes: 1m
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;

      for (const chatId of chatIds) {
        await editTelegramMessage(token, chatId, existingSignal.messageId, updatedMessage);
      }
    }
    return;
  }

  if (rsi15m < RSI_THRESHOLD_15m && rsi5m > RSI_THRESHOLD_5m && rsi1m > RSI_THRESHOLD_1m) {
    const currentTime = moment();
    const lastNotificationTime = lastNotificationTimes[symbol];

    if (lastNotificationTime && currentTime.diff(lastNotificationTime, 'minutes') < 30) return;

    lastNotificationTimes[symbol] = currentTime;

    if (!entryPrices[symbol]) entryPrices[symbol] = [];
    if (entryPrices[symbol].length === 0 || currentPrice <= entryPrices[symbol][0] * 0.99) {
      entryPrices[symbol].unshift(currentPrice);
    }

    const sellPrice = (entryPrices[symbol][0] * 1.011).toFixed(8);
    const message = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices[symbol].join('-')}
💰 Sell Price: ${sellPrice}
🕒 Timeframes: 1m
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;

    const messageIds = [];
    for (const chatId of chatIds) {
      const messageId = await sendTelegramMessage(token, chatId, message);
      messageIds.push(messageId);
    }

    sellPrices[symbol] = {
      entryPrices: entryPrices[symbol],
      sellPrice,
      messageId: messageIds[0],
      buyTime: currentTime,
      btcPriceAtBuy: btcData.price,
    };
    bottomPrices[symbol] = currentPrice;
  }
};

export const checkTargetAchieved = async (token, chatIds) => {
  for (const symbol in sellPrices) {
    const { sellPrice, entryPrices, messageId, buyTime } = sellPrices[symbol];
    const prices = await fetchCandlestickData(symbol, '1m');
    const btcData = await calculateBTCChanges();

    if (!prices) continue;

    const currentPrice = prices[prices.length - 1];

    if (currentPrice < bottomPrices[symbol]) {
      bottomPrices[symbol] = currentPrice;
    }

    if (currentPrice >= sellPrice) {
      const duration = moment.duration(moment().diff(buyTime));
      const period = `${duration.hours()}h ${duration.minutes()}m ${duration.seconds()}s`;

      const bottomPrice = bottomPrices[symbol];
      const percentageDrop = (((entryPrices[0] - bottomPrice) / entryPrices[0]) * 100).toFixed(2);

      const btcChange = btcData.price
        ? ((btcData.price - sellPrices[symbol].btcPriceAtBuy) / sellPrices[symbol].btcPriceAtBuy * 100).toFixed(2)
        : null;

      const newMessage = `
📢 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Prices: ${entryPrices.join('-')}
💰 Sell Price: ${sellPrice}
📉 Bottom Price: ${bottomPrice}
📉 Percentage Drop: ${percentageDrop}%
✅ Target Achieved
⏱️ Duration: ${period}
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;

      for (const chatId of chatIds) {
        await editTelegramMessage(token, chatId, messageId, newMessage);
      }

      logBuySignal(
        symbol,
        RSI_THRESHOLD_15m,
        RSI_THRESHOLD_5m,
        RSI_THRESHOLD_1m,
        entryPrices[0],
        sellPrice,
        period,
        bottomPrice,
        percentageDrop,
        btcChange,
        btcData.change30m
      );

      delete sellPrices[symbol];
      delete bottomPrices[symbol];
      delete entryPrices[symbol];
    }
  }
};
