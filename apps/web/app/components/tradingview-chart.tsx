'use client';

import { useEffect, useRef } from 'react';
import {
  type BusinessDay,
  ColorType,
  createChart,
  CrosshairMode,
  LastPriceAnimationMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

type TradingViewPoint = {
  timestamp: number;
  price: number;
};

type TradingViewSeries = {
  marketId: string;
  exchangeName: string;
  symbol: string;
  instrumentType: 'spot' | 'futures';
  color: string;
  points: TradingViewPoint[];
};

type TradingViewChartProps = {
  ariaLabel: string;
  chartMode: 'price' | 'premium';
  chartTimeframe: 'tick' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1M';
  series: TradingViewSeries[];
};

function chartBarSpacing(chartTimeframe: TradingViewChartProps['chartTimeframe']) {
  switch (chartTimeframe) {
    case '1M':
      return 56;
    case '1d':
      return 42;
    case '4h':
      return 34;
    case '1h':
      return 28;
    case '15m':
      return 24;
    case '5m':
      return 20;
    case '1m':
      return 16;
    case 'tick':
    default:
      return 12;
  }
}

function chartRightOffset(chartTimeframe: TradingViewChartProps['chartTimeframe']) {
  switch (chartTimeframe) {
    case '1M':
      return 0.7;
    case '1d':
      return 0.9;
    case '4h':
      return 1;
    case '1h':
      return 1.05;
    case '15m':
      return 1.1;
    case '5m':
      return 1.2;
    case '1m':
      return 1.35;
    case 'tick':
    default:
      return 1.15;
  }
}

function normalizeLineData(points: TradingViewPoint[]) {
  const pointMap = new Map<number, number>();

  for (const point of points) {
    pointMap.set(point.timestamp, point.price);
  }

  return Array.from(pointMap.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([timestamp, price]) => ({
      time: Math.floor(timestamp / 1000) as UTCTimestamp,
      value: price,
    })) satisfies LineData[];
}

function browserLocale() {
  if (typeof navigator === 'undefined') {
    return 'en-US';
  }

  return navigator.language || 'en-US';
}

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

function formatLocalTime(time: Time, chartTimeframe: TradingViewChartProps['chartTimeframe']) {
  const localDate = timeToLocalDate(time);
  if (!localDate) {
    return '';
  }

  switch (chartTimeframe) {
    case 'tick':
      return localDate.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    case '1m':
    case '5m':
    case '15m':
      return localDate.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    case '1h':
    case '4h':
      return localDate.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    case '1d':
      return localDate.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
      });
    case '1M':
      return localDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
      });
    default:
      return localDate.toLocaleString();
  }
}

export function TradingViewChart({ ariaLabel, chartMode, chartTimeframe, series }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const lastViewportResetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: '#0b1220' },
        textColor: '#cbd5e1',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(59, 130, 246, 0.10)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.14)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(96, 165, 250, 0.35)',
          width: 1,
          labelBackgroundColor: '#2563eb',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.35)',
          width: 1,
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.20)',
        scaleMargins: { top: 0.14, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.20)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: chartRightOffset(chartTimeframe),
        barSpacing: chartBarSpacing(chartTimeframe),
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      // autoSize handles dimensions; avoid resetting the user's zoom on resize
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      seriesRefs.current.clear();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    const includeSeconds = chartTimeframe === 'tick';

    chart.applyOptions({
      localization: {
        locale: browserLocale(),
        timeFormatter: (time: Time) => formatLocalTime(time, chartTimeframe),
        priceFormatter: (value: number) => (chartMode === 'price' ? `$${value.toFixed(value >= 100 ? 2 : 4)}` : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`),
      },
      timeScale: {
        secondsVisible: includeSeconds,
        rightOffset: chartRightOffset(chartTimeframe),
        barSpacing: chartBarSpacing(chartTimeframe),
        tickMarkFormatter: (time: Time) => formatLocalTime(time, chartTimeframe),
      },
    });

    const nextSeriesIds = new Set(series.map((entry) => entry.marketId));

    for (const [marketId, lineSeries] of seriesRefs.current.entries()) {
      if (!nextSeriesIds.has(marketId)) {
        chart.removeSeries(lineSeries);
        seriesRefs.current.delete(marketId);
      }
    }

    for (const entry of series) {
      let lineSeries = seriesRefs.current.get(entry.marketId);
      if (!lineSeries) {
        lineSeries = chart.addSeries(LineSeries, {
          color: entry.color,
          lineWidth: 2,
          lineStyle: entry.instrumentType === 'futures' ? LineStyle.LargeDashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          lastPriceAnimation: LastPriceAnimationMode.OnDataUpdate,
        });
        seriesRefs.current.set(entry.marketId, lineSeries);
      } else {
        lineSeries.applyOptions({
          color: entry.color,
          lineStyle: entry.instrumentType === 'futures' ? LineStyle.LargeDashed : LineStyle.Solid,
        });
      }

      const lineData = normalizeLineData(entry.points);
      lineSeries.setData(lineData);
    }

    const viewportResetKey = `${chartMode}:${chartTimeframe}:${series.map((entry) => entry.marketId).join('|')}`;
    if (lastViewportResetKeyRef.current !== viewportResetKey) {
      lastViewportResetKeyRef.current = viewportResetKey;
      chart.timeScale().fitContent();
    }
  }, [chartMode, chartTimeframe, series]);

  return <div ref={containerRef} className="tradingview-chart-wrap" role="img" aria-label={ariaLabel} />;
}
