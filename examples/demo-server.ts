/**
 * Realistic Mock MCP Server for AgentTX Demo
 * Implements appointment booking and payment operations with simulated failure modes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// In-memory data store for demo
const appointments = new Map<string, { id: string; patientId: string; doctorId: string; date: string; slot: string; status: string }>();
const payments = new Map<string, { id: string; customerId: string; orderId: string; amount: number; status: string }>();

let bookingAttemptCount = 0;

const server = new Server(
  {
    name: 'demo-clinic-payment-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_appointment',
        description: 'Fetch appointment details by patient ID or appointment ID',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string' },
            patientId: { type: 'string' },
            date: { type: 'string' },
          },
        },
      },
      {
        name: 'book_appointment',
        description: 'Book a medical appointment slot for a patient',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: { type: 'string' },
            doctorId: { type: 'string' },
            date: { type: 'string' },
            slot: { type: 'string' },
            patientPhone: { type: 'string' },
            medicalNote: { type: 'string' },
          },
          required: ['patientId', 'doctorId', 'date', 'slot'],
        },
      },
      {
        name: 'cancel_appointment',
        description: 'Cancel an existing medical appointment',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string' },
          },
          required: ['appointmentId'],
        },
      },
      {
        name: 'process_payment',
        description: 'Charge customer credit card for an order',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: { type: 'string' },
            orderId: { type: 'string' },
            amount: { type: 'number' },
            cardNumber: { type: 'string' },
            cvv: { type: 'string' },
          },
          required: ['customerId', 'orderId', 'amount'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolArgs = (args || {}) as Record<string, unknown>;

  if (name === 'get_appointment') {
    const patientId = toolArgs.patientId as string;
    const date = toolArgs.date as string;
    const apptId = toolArgs.appointmentId as string;

    for (const appt of appointments.values()) {
      if (appt.id === apptId || (appt.patientId === patientId && appt.date === date)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(appt) }],
        };
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Appointment not found' }) }],
    };
  }

  if (name === 'book_appointment') {
    bookingAttemptCount++;
    const { patientId, doctorId, date, slot } = toolArgs as Record<string, string>;

    const apptId = `appt_${patientId}_${date}_${slot}`;
    const appt = {
      id: apptId,
      patientId,
      doctorId,
      date,
      slot,
      status: 'CONFIRMED',
    };

    appointments.set(apptId, appt);

    // Simulate transient network timeout on first attempt if requested by env
    if (process.env.SIMULATE_FLAKY_TIMEOUT === '1' && bookingAttemptCount === 1) {
      // Delay response beyond client timeout so client experiences timeout, but server state commits!
      await new Promise(r => setTimeout(r, 6000));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            appointmentId: apptId,
            status: 'CONFIRMED',
            message: `Appointment booked for doctor ${doctorId} at ${date} ${slot}`,
          }),
        },
      ],
    };
  }

  if (name === 'cancel_appointment') {
    const apptId = toolArgs.appointmentId as string;
    if (appointments.has(apptId)) {
      appointments.delete(apptId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'CANCELLED', appointmentId: apptId }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Appointment not found to cancel' }) }],
    };
  }

  if (name === 'process_payment') {
    const { customerId, orderId, amount } = toolArgs;
    const paymentId = `pay_${orderId}`;
    const payment = {
      id: paymentId,
      customerId: String(customerId),
      orderId: String(orderId),
      amount: Number(amount),
      status: 'CHARGED',
    };
    payments.set(paymentId, payment);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            paymentId,
            status: 'CHARGED',
            amount,
          }),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[Mock MCP Server] Online and ready.\n');
}

main().catch(err => {
  process.stderr.write(`[Mock MCP Server] Fatal error: ${err}\n`);
  process.exit(1);
});
