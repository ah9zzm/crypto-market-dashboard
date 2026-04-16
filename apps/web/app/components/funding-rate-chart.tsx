'use client';

import { useEffect, useRef } from 'react';
import {
  type BusinessDay,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

type FundingRateChartPoint = {
  timestamp: number;
  fundingRate: number;
};

type FundingRateChartProps = {
  ariaLabel: string;
  points: FundingRateChartPoint[];
};

function timeToLocalDate(time: Time): Date | null {
  if (typeof time === 'number') {
    return new Date(time * 1000);
  }

  if (typeof time === 'string') {
    const parsed = new Date(time);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const businessDay = time as BusinessDay;
  return new Date(Date.UTC(businessDay.year, businessDay.month - 1, businessDay.day));
}

function formatLocalTime(time: Time) {
  const localDate = timeToLocalDate(time);
  if (!localDate) {
    return '';
  }

  return localDate.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeHistogramData(points: FundingRateChartPoint[]) {
  const pointMap = new Map<number, number>();

  for (const point of points) {
    pointMap.set(point.timestamp, point.fundingRate * 100);
  }

  return Array.from(pointMap.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([timestamp, fundingRatePct]) => ({
      time: Math.floor(timestamp / 1000) as UTCTimestamp,
      value: fundingRatePct,
      color: fundingRatePct >= 0 ? '#22c55e' : '#f97316',
    })) satisfies HistogramData[];
}

export function FundingRateChart({ ariaLabel, points }: FundingRateChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 168,
      layout: {
        background: { type: ColorType.Solid, color: '#0b1220' },
        textColor: '#94a3b8',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(59, 130, 246, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.10)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(96, 165, 250, 0.25)',
          width: 1,
          labelBackgroundColor: '#2563eb',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.25)',
          width: 1,
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        scaleMargins: { top: 0.16, bottom: 0.16 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 14,
      },
      handleScroll: true,
      handleScale: true,
    });

    const histogramSeries = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: true,
      base: 0,
    });

    chart.applyOptions({
      localization: {
        locale: typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US',
        timeFormatter: (time: Time) => formatLocalTime(time),
        priceFormatter: (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(4)}%`,
      },
      timeScale: {
        tickMarkFormatter: (time: Time) => formatLocalTime(time),
      },
    });

    chartRef.current = chart;
    seriesRef.current = histogramSeries;

    const resizeObserver = new ResizeObserver(() => {
      // autoSize handles dimensions; preserve user interaction state
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) {
      return;
    }

    series.setData(normalizeHistogramData(points));
    chart.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="funding-rate-chart-wrap" role="img" aria-label={ariaLabel} />;
}
