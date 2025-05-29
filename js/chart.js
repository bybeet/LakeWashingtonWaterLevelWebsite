/**
 * chart.js - Handles chart configuration and rendering for Lake Washington water levels
 */

class WaterLevelChart {
    constructor(elementId) {
        this.chartElement = document.getElementById(elementId);
        this.chart = null;
        this.currentData = [];
        this.showAverageLine = false;
        this.averageValue = 0;
    }

    /**
     * Initialize the chart with data
     * @param {Array} data - Data to display in the chart
     */
    initChart(data) {
        this.currentData = data;
        this.renderChart();
    }

    /**
     * Update the chart with new data
     * @param {Array} data - New data to display
     */
    updateChart(data) {
        this.currentData = data;
        this.renderChart();
    }

    /**
     * Toggle the average line visibility
     * @param {boolean} show - Whether to show the average line
     * @param {number} avgValue - The average value to display
     */
    toggleAverageLine(show, avgValue) {
        this.showAverageLine = show;
        this.averageValue = avgValue;
        this.renderChart();
    }

    /**
     * Render the chart with current data
     */
    renderChart() {
        if (!this.currentData || this.currentData.length === 0) {
            console.warn('No data available to render chart');
            return;
        }

        // Prepare data for Plotly
        const timestamps = this.currentData.map(item => item.timestamp);
        const waterLevels = this.currentData.map(item => item.waterLevel);

        // Create traces for the chart
        const traces = [
            {
                x: timestamps,
                y: waterLevels,
                type: 'scatter',
                mode: 'lines+markers',
                name: 'Water Level',
                line: {
                    color: '#0d6efd',
                    width: 2
                },
                marker: {
                    size: 5,
                    opacity: 0.7
                },
                hovertemplate: 
                    '<b>Date:</b> %{x|%Y-%m-%d %H:%M}<br>' +
                    '<b>Water Level:</b> %{y:.2f} ft<extra></extra>'
            }
        ];

        // Add average line if enabled
        if (this.showAverageLine && this.averageValue) {
            traces.push({
                x: [timestamps[0], timestamps[timestamps.length - 1]],
                y: [this.averageValue, this.averageValue],
                type: 'scatter',
                mode: 'lines',
                name: 'Average',
                line: {
                    color: '#dc3545',
                    width: 2,
                    dash: 'dash'
                },
                hovertemplate: '<b>Average:</b> %{y:.2f} ft<extra></extra>'
            });
        }

        // Chart layout configuration
        const layout = {
            autosize: true,
            margin: { l: 50, r: 20, t: 20, b: 50 },
            xaxis: {
                title: 'Date & Time',
                type: 'date',
                tickformat: '%m/%d/%y %H:%M',
                showgrid: true,
                gridcolor: '#e9ecef'
            },
            connectgaps: false, // Set to true to connect across nulls
            yaxis: {
                title: 'Water Level (feet)',
                showgrid: true,
                gridcolor: '#e9ecef',
                zeroline: false
            },
            hoverlabel: {
                bgcolor: '#fff',
                bordercolor: '#dee2e6',
                font: { family: 'Arial', size: 12 }
            },
            showlegend: true,
            legend: {
                orientation: 'h',
                y: -0.2
            },
            plot_bgcolor: '#ffffff',
            paper_bgcolor: '#ffffff'
        };

        // Chart configuration
        const config = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            displaylogo: false,
            toImageButtonOptions: {
                format: 'png',
                filename: 'lake_washington_water_level',
                height: 500,
                width: 900,
                scale: 2
            }
        };

        // Create or update the chart
        Plotly.newPlot(this.chartElement, traces, layout, config);
    }

    /**
     * Download the chart as an image
     */
    downloadChart() {
        if (!this.chartElement) {
            console.error('Chart element not found');
            return;
        }

        Plotly.downloadImage(this.chartElement, {
            format: 'png',
            filename: 'lake_washington_water_level',
            height: 500,
            width: 900,
            scale: 2
        });
    }
}

// Create a global instance of the chart
const waterLevelChart = new WaterLevelChart('chart');
