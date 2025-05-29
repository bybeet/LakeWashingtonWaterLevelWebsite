/**
 * dataLoader.js - Handles loading and processing CSV data for Lake Washington water levels
 */

class DataLoader {
    constructor() {
        this.rawData = [];
        this.processedData = [];
        this.dataLoaded = false;
        this.dataFile = 'data/lake_data.csv';
    }

    /**
     * Load CSV data from file
     * @returns {Promise} Promise that resolves when data is loaded
     */
    loadData() {
        return new Promise((resolve, reject) => {
            Papa.parse(this.dataFile, {
                download: true,
                header: false,
                skipEmptyLines: true,
                complete: (results) => {
                    this.rawData = results.data;
                    this.processData();
                    this.dataLoaded = true;
                    console.log(`Loaded ${this.processedData.length} data points`);
                    resolve(this.processedData);
                },
                error: (error) => {
                    console.error('Error loading CSV data:', error);
                    reject(error);
                }
            });
        });
    }

    /**
     * Process raw CSV data into usable format
     */
    processData() {
        this.processedData = this.rawData
            .map(row => {
                const waterLevelStr = row[1] ? row[1].trim() : "";
                const waterLevel = (waterLevelStr === "" || waterLevelStr === "---") 
                    ? null 
                    : parseFloat(waterLevelStr);
                
                return {
                    timestamp: new Date(row[0]),
                    waterLevel: waterLevel
                };
            })
            .filter(item => item.timestamp && !isNaN(item.timestamp)) // Filter out invalid timestamps
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Get data filtered by date range
     * @param {number} days - Number of days to include (from latest data point)
     * @returns {Array} Filtered data array
     */
    getFilteredData(days) {
        if (!this.dataLoaded) {
            return [];
        }

        if (days === 'all') {
            return this.processedData;
        }

        const now = this.getLatestDate();
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - days);

        return this.processedData.filter(item => item.timestamp >= cutoff);
    }

    /**
     * Get data filtered by custom date range
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {Array} Filtered data array
     */
    getCustomRangeData(startDate, endDate) {
        if (!this.dataLoaded) {
            return [];
        }

        return this.processedData.filter(item => 
            item.timestamp >= startDate && item.timestamp <= endDate
        );
    }

    /**
     * Get the latest date in the dataset
     * @returns {Date} Latest date
     */
    getLatestDate() {
        if (!this.dataLoaded || this.processedData.length === 0) {
            return new Date();
        }
        return this.processedData[this.processedData.length - 1].timestamp;
    }

    /**
     * Get the earliest date in the dataset
     * @returns {Date} Earliest date
     */
    getEarliestDate() {
        if (!this.dataLoaded || this.processedData.length === 0) {
            return new Date();
        }
        return this.processedData[0].timestamp;
    }

    /**
     * Calculate statistics for a given dataset
     * @param {Array} data - Dataset to calculate statistics for
     * @returns {Object} Object containing min, max, and average values
     */
    calculateStatistics(data) {
        if (!data || data.length === 0) {
            return { min: 0, max: 0, avg: 0, validPoints: 0, totalPoints: 0 };
        }

        // Filter out null values for statistics calculation
        const validWaterLevels = data
            .map(item => item.waterLevel)
            .filter(level => level !== null && !isNaN(level));
        
        if (validWaterLevels.length === 0) {
            return { min: 0, max: 0, avg: 0, validPoints: 0, totalPoints: data.length };
        }

        const min = Math.min(...validWaterLevels);
        const max = Math.max(...validWaterLevels);
        const sum = validWaterLevels.reduce((acc, val) => acc + val, 0);
        const avg = sum / validWaterLevels.length;

        return {
            min: parseFloat(min.toFixed(2)),
            max: parseFloat(max.toFixed(2)),
            avg: parseFloat(avg.toFixed(2)),
            validPoints: validWaterLevels.length,
            totalPoints: data.length
        };
    }
}

// Create a global instance of the DataLoader
const dataLoader = new DataLoader();
