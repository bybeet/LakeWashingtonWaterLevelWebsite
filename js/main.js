/**
 * main.js - Main application logic for Lake Washington water level visualization
 */

// DOM elements
const timeRangeSelect = document.getElementById('timeRange');
const startDateInput = document.getElementById('startDate');
const endDateInput = document.getElementById('endDate');
const applyCustomRangeBtn = document.getElementById('applyCustomRange');
const showAverageCheckbox = document.getElementById('showAverage');
const minValueElement = document.getElementById('minValue');
const maxValueElement = document.getElementById('maxValue');
const avgValueElement = document.getElementById('avgValue');
const latestTimeElement = document.getElementById('latestTime');
const latestLevelElement = document.getElementById('latestLevel');

// Current state
let currentData = [];
let statistics = { min: 0, max: 0, avg: 0 };

/**
 * Initialize the application
 */
async function initApp() {
    try {
        // Load data
        await dataLoader.loadData();
        
        // Update latest data display
        updateLatestDataDisplay();
        
        // Set default date range (2 weeks)
        updateDateRange(14);
        
        // Set up event listeners
        setupEventListeners();
        
        // Initialize date pickers with valid range
        initDatePickers();
    } catch (error) {
        console.error('Failed to initialize application:', error);
        alert('Failed to load water level data. Please try refreshing the page.');
    }
}

/**
 * Set up event listeners for UI controls
 */
function setupEventListeners() {
    // Time range selector
    timeRangeSelect.addEventListener('change', (e) => {
        const days = e.target.value;
        updateDateRange(days);
    });
    
    // Custom date range
    applyCustomRangeBtn.addEventListener('click', () => {
        applyCustomDateRange();
    });
    
    // Average line toggle
    showAverageCheckbox.addEventListener('change', (e) => {
        waterLevelChart.toggleAverageLine(e.target.checked, statistics.avg);
    });
}

/**
 * Update the latest data display with the most recent time and water level
 */
function updateLatestDataDisplay() {
    if (!dataLoader.dataLoaded || dataLoader.processedData.length === 0) {
        return;
    }
    
    // Get the latest data point
    const latestData = dataLoader.processedData[dataLoader.processedData.length - 1];
    
    // Format the timestamp
    const formattedTime = latestData.timestamp.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    // Update the display
    latestTimeElement.textContent = formattedTime;
    latestLevelElement.textContent = latestData.waterLevel !== null 
        ? `${latestData.waterLevel.toFixed(2)} ft` 
        : 'No data';
}

/**
 * Initialize date pickers with valid date range
 */
function initDatePickers() {
    const earliestDate = dataLoader.getEarliestDate();
    const latestDate = dataLoader.getLatestDate();
    
    // Format dates for date inputs (YYYY-MM-DD)
    const formatDateForInput = (date) => {
        return date.toISOString().split('T')[0];
    };
    
    // Set min/max attributes for date inputs
    startDateInput.min = formatDateForInput(earliestDate);
    startDateInput.max = formatDateForInput(latestDate);
    endDateInput.min = formatDateForInput(earliestDate);
    endDateInput.max = formatDateForInput(latestDate);
    
    // Set default values (last 2 weeks)
    const twoWeeksAgo = new Date(latestDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    startDateInput.value = formatDateForInput(twoWeeksAgo);
    endDateInput.value = formatDateForInput(latestDate);
}

/**
 * Update the chart with data for the specified number of days
 * @param {number|string} days - Number of days to display, or 'all' for all data
 */
function updateDateRange(days) {
    // Get filtered data
    currentData = dataLoader.getFilteredData(days);
    
    // Update chart
    waterLevelChart.updateChart(currentData);
    
    // Update statistics
    updateStatistics();
    
    // Update average line if enabled
    if (showAverageCheckbox.checked) {
        waterLevelChart.toggleAverageLine(true, statistics.avg);
    }
    
    // Update latest data display
    updateLatestDataDisplay();
}

/**
 * Apply custom date range from date inputs
 */
function applyCustomDateRange() {
    const startDate = new Date(startDateInput.value);
    const endDate = new Date(endDateInput.value);
    
    // Add one day to end date to include the full day
    endDate.setDate(endDate.getDate() + 1);
    
    // Validate dates
    if (startDate > endDate) {
        alert('Start date must be before end date');
        return;
    }
    
    // Get data for custom range
    currentData = dataLoader.getCustomRangeData(startDate, endDate);
    
    // Update chart
    waterLevelChart.updateChart(currentData);
    
    // Update statistics
    updateStatistics();
    
    // Update average line if enabled
    if (showAverageCheckbox.checked) {
        waterLevelChart.toggleAverageLine(true, statistics.avg);
    }
    
    // Set time range select to custom
    timeRangeSelect.value = 'custom';
}

/**
 * Update statistics display
 */
function updateStatistics() {
    // Calculate statistics
    statistics = dataLoader.calculateStatistics(currentData);
    
    // Update display
    minValueElement.textContent = `${statistics.min} ft`;
    maxValueElement.textContent = `${statistics.max} ft`;
    avgValueElement.textContent = `${statistics.avg} ft`;
    
    // Update data quality information if the elements exist
    const dataQualityElement = document.getElementById('dataQuality');
    const validPointsElement = document.getElementById('validPoints');
    const totalPointsElement = document.getElementById('totalPoints');
    
    if (dataQualityElement && validPointsElement && totalPointsElement) {
        const qualityPercent = statistics.totalPoints > 0 
            ? Math.round((statistics.validPoints / statistics.totalPoints) * 100) 
            : 0;
        dataQualityElement.textContent = `${qualityPercent}%`;
        validPointsElement.textContent = statistics.validPoints;
        totalPointsElement.textContent = statistics.totalPoints;
    }
}

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', initApp);
