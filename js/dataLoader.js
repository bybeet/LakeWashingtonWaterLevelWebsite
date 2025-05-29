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
     * Apply simple moving average smoothing
     * @param {Array} data - Data to smooth
     * @param {number} windowSize - Size of moving window (odd number)
     * @returns {Array} Smoothed data
     */
    applyMovingAverage(data, windowSize) {
        return data.map((point, index, array) => {
            // Calculate window boundaries
            const start = Math.max(0, index - Math.floor(windowSize/2));
            const end = Math.min(array.length - 1, index + Math.floor(windowSize/2));
            
            // Get points in window
            const windowPoints = array.slice(start, end + 1)
                .filter(p => p.waterLevel !== null);
            
            if (windowPoints.length === 0) {
                return {...point}; // Return copy of original point if no valid points
            }
            
            // Calculate average
            const sum = windowPoints.reduce((acc, p) => acc + p.waterLevel, 0);
            const avg = sum / windowPoints.length;
            
            return {
                timestamp: point.timestamp,
                waterLevel: avg,
                isSmoothed: true
            };
        });
    }
    
    /**
     * Downsample data using LTTB algorithm
     * @param {Array} data - Data to downsample
     * @param {number} threshold - Target number of points
     * @returns {Array} Downsampled data
     */
    downsampleLTTB(data, threshold) {
        if (data.length <= threshold || threshold <= 2) return data;
        
        const result = [];
        // Always include first point
        result.push(data[0]);
        
        // Bucket size
        const bucketSize = (data.length - 2) / (threshold - 2);
        
        let lastSelectedIndex = 0;
        for (let i = 0; i < threshold - 2; i++) {
            // Calculate bucket boundaries
            const startIndex = Math.floor((i + 0) * bucketSize) + 1;
            const endIndex = Math.floor((i + 1) * bucketSize) + 1;
            const nextEndIndex = Math.floor((i + 2) * bucketSize) + 1;
            
            // Find point in this bucket with largest triangle area
            let maxArea = -1;
            let maxAreaIndex = startIndex;
            
            const a = data[lastSelectedIndex]; // Last selected point
            
            // For each point in current bucket
            for (let j = startIndex; j < endIndex; j++) {
                // Skip points with null values
                if (data[j].waterLevel === null) continue;
                
                // For each point in next bucket
                let nextBucketSum = 0;
                let nextBucketCount = 0;
                
                for (let k = endIndex; k < nextEndIndex && k < data.length; k++) {
                    if (data[k].waterLevel !== null) {
                        nextBucketSum += data[k].waterLevel;
                        nextBucketCount++;
                    }
                }
                
                // If no valid points in next bucket, use last point
                const c = nextBucketCount > 0 
                    ? { timestamp: new Date((endIndex + nextEndIndex) / 2), 
                        waterLevel: nextBucketSum / nextBucketCount } 
                    : data[Math.min(data.length - 1, nextEndIndex)];
                
                // Current point
                const b = data[j];
                
                // Calculate triangle area
                const area = Math.abs(
                    (a.timestamp - c.timestamp) * (b.waterLevel - a.waterLevel) -
                    (a.timestamp - b.timestamp) * (c.waterLevel - a.waterLevel)
                ) * 0.5;
                
                // Update if this triangle has larger area
                if (area > maxArea) {
                    maxArea = area;
                    maxAreaIndex = j;
                }
            }
            
            // Add point with largest triangle area
            result.push(data[maxAreaIndex]);
            lastSelectedIndex = maxAreaIndex;
        }
        
        // Always include last point
        result.push(data[data.length - 1]);
        
        return result;
    }
    
    /**
     * Get adaptively processed data based on time range
     * @param {Array} data - Original data array
     * @param {number} days - Number of days in view
     * @param {boolean} smoothingEnabled - Whether to apply smoothing
     * @param {boolean} showAllPoints - Override to show all points
     * @returns {Array} Processed data
     */
    getAdaptiveData(data, days, smoothingEnabled, showAllPoints) {
        if (showAllPoints) {
            return data;
        }
        
        // Determine appropriate sampling based on time range
        let processedData = data;
        
        // Apply downsampling for longer time ranges
        if (days > 90) {
            // For very long ranges (3+ months)
            processedData = this.downsampleLTTB(data, 300);
        } else if (days > 30) {
            // For medium ranges (1-3 months)
            processedData = this.downsampleLTTB(data, 500);
        } else if (days > 7) {
            // For shorter ranges (1-4 weeks)
            processedData = this.downsampleLTTB(data, 1000);
        }
        
        // Apply smoothing if enabled
        if (smoothingEnabled) {
            // Window size depends on data density and time range
            // Larger window = smoother curve
            const windowSize = Math.max(3, Math.min(11, Math.ceil(days / 7) * 2 + 1));
            processedData = this.applyMovingAverage(processedData, windowSize);
        }
        
        return processedData;
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
