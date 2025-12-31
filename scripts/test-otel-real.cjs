#!/usr/bin/env node

/**
 * 真实环境下的 OpenTelemetry 测试
 * 模拟 Cloudflare Worker 环境
 */

const { trace, context, propagation } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

// 模拟 Cloudflare Worker 环境
class MockRequest {
  constructor(url, method = 'GET', headers = {}) {
    this.url = url;
    this.method = method;
    this.headers = new Map(Object.entries(headers));
  }
  
  get(key) {
    return this.headers.get(key);
  }
  
  clone() {
    return new MockRequest(this.url, this.method, Object.fromEntries(this.headers));
  }
}

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.headers = new Map(Object.entries(init.headers || {}));
  }
}

// 模拟 env 对象
const mockEnv = {
  AXIOM_TOKEN: process.env.AXIOM_TOKEN,
  AXIOM_DATASET: process.env.AXIOM_DATASET
};

console.log('🧪 真实环境 OpenTelemetry 测试');
console.log('='.repeat(50));

// 1. 初始化 OpenTelemetry
console.log('\n1. 初始化 OpenTelemetry Provider...');

const exporter = new OTLPTraceExporter({
  url: 'https://api.axiom.co/v1/traces',
  headers: {
    'Authorization': `Bearer ${mockEnv.AXIOM_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

const provider = new BasicTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'lb-worker-js-test',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0'
  })
});

provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

trace.setGlobalTracerProvider(provider);

console.log('✅ OpenTelemetry Provider 已注册');

// 2. 创建一个 span 并记录日志
console.log('\n2. 创建 Span 并记录日志...');

async function testSpanCreation() {
  const tracer = trace.getTracer('test-tracer');
  
  return tracer.startActiveSpan('test-operation', async (span) => {
    console.log(`✅ Span 创建成功: ${span.spanContext().spanId}`);
    
    // 设置 span 属性
    span.setAttribute('http.url', 'http://localhost:8787/api/webhook');
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.status_code', 200);
    span.setAttribute('custom.field', 'test-value');
    
    // 添加事件
    span.addEvent('test-event', { 
      'event.data': 'This is a test event',
      'timestamp': Date.now()
    });
    
    console.log('✅ Span 属性和事件已设置');
    
    // 模拟一些异步操作
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 结束 span
    span.end();
    
    console.log('✅ Span 已结束');
    
    return span;
  });
}

// 3. 测试多个 span
console.log('\n3. 测试多个 Span...');

async function testMultipleSpans() {
  const tracer = trace.getTracer('multi-test');
  
  for (let i = 1; i <= 3; i++) {
    await tracer.startActiveSpan(`operation-${i}`, async (span) => {
      span.setAttribute('iteration', i);
      span.setAttribute('data', `test-data-${i}`);
      
      console.log(`✅ Span ${i} 创建并结束`);
      
      await new Promise(resolve => setTimeout(resolve, 50));
      span.end();
    });
  }
}

// 4. 测试嵌套 span
console.log('\n4. 测试嵌套 Span...');

async function testNestedSpans() {
  const tracer = trace.getTracer('nested-test');
  
  return tracer.startActiveSpan('parent-span', async (parentSpan) => {
    console.log('✅ 父 Span 创建');
    
    parentSpan.setAttribute('parent.field', 'parent-value');
    
    // 子 span
    await tracer.startActiveSpan('child-span-1', async (childSpan1) => {
      console.log('✅ 子 Span 1 创建');
      childSpan1.setAttribute('child.field', 'child-1-value');
      
      // 更深层的嵌套
      await tracer.startActiveSpan('grandchild-span', async (grandchildSpan) => {
        console.log('✅ 孙 Span 创建');
        grandchildSpan.setAttribute('grandchild.field', 'grandchild-value');
        
        await new Promise(resolve => setTimeout(resolve, 30));
        grandchildSpan.end();
      });
      
      await new Promise(resolve => setTimeout(resolve, 30));
      childSpan1.end();
    });
    
    // 另一个子 span
    await tracer.startActiveSpan('child-span-2', async (childSpan2) => {
      console.log('✅ 子 Span 2 创建');
      childSpan2.setAttribute('child.field', 'child-2-value');
      
      await new Promise(resolve => setTimeout(resolve, 30));
      childSpan2.end();
    });
    
    parentSpan.end();
    console.log('✅ 父 Span 已结束');
  });
}

// 5. 测试错误记录
console.log('\n5. 测试错误记录...');

async function testErrorRecording() {
  const tracer = trace.getTracer('error-test');
  
  return tracer.startActiveSpan('error-operation', async (span) => {
    try {
      console.log('✅ 开始错误测试操作');
      
      // 模拟一个错误
      throw new Error('这是一个测试错误');
    } catch (error) {
      console.log('❌ 捕获到错误，记录到 span...');
      span.recordException(error);
      span.setAttribute('error.type', 'TestError');
      span.setAttribute('error.message', error.message);
      
      // 不结束 span，让测试继续
    } finally {
      span.end();
      console.log('✅ 错误 Span 已结束');
    }
  });
}

// 6. 等待所有日志发送
console.log('\n6. 等待日志发送到 Axiom...');

async function waitForLogs() {
  // 给一些时间让日志发送
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('✅ 等待完成');
}

// 运行所有测试
async function runAllTests() {
  try {
    await testSpanCreation();
    await testMultipleSpans();
    await testNestedSpans();
    await testErrorRecording();
    await waitForLogs();
    
    console.log('\n' + '='.repeat(50));
    console.log('🎉 所有测试完成！');
    console.log('请检查 Axiom 控制台，应该能看到以下数据:');
    console.log('  - test-operation');
    console.log('  - operation-1, operation-2, operation-3');
    console.log('  - parent-span (包含 child-span-1, child-span-2, grandchild-span)');
    console.log('  - error-operation (带有错误信息)');
    console.log('\n如果在 Axiom 中看不到数据，请检查:');
    console.log('  1. AXIOM_TOKEN 是否正确');
    console.log('  2. AXIOM_DATASET 是否存在');
    console.log('  3. 网络连接是否正常');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    process.exit(1);
  }
}

runAllTests();